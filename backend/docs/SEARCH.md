# Search (Phase 10)

Cross-entity search over users, projects, communities, posts, and tags —
one endpoint, PostgreSQL-backed, behind an abstraction that can be re-pointed
at a dedicated engine without changing the API contract.

Specification: `BACKEND_PRD.md` §15, `BACKEND_TRD.md` §8, §11, §24,
`BACKEND_ARCHITECTURE.md` §24, §28, §29. Phase order from §38.

**No schema change was required.** Every entity is matched on columns the
Phase 2 schema already carries. Migration count remains **2**.

---

## What the specification actually says

Eleven lines, across two documents that agree:

> **PRD §15** — Search must support: Users, Projects, Communities, Posts, Tags.
> Search must support: Query, Filtering, Sorting, Pagination.

> **TRD §24** — Initial search may use PostgreSQL capabilities… The
> architecture should allow future migration to Elasticsearch, OpenSearch,
> Meilisearch, or another dedicated search engine. Do not tightly couple
> application logic to a specific future search provider.

> **ARCHITECTURE §24** — Initial implementation: PostgreSQL search. Create a
> SearchService abstraction. Frontend calls SearchService, not PostgreSQL
> directly. Future implementation may replace the underlying engine… without
> changing the API contract.

Everything else — the endpoint signature, the parameters, the response shape,
the ordering, the visibility rules — is unspecified. There is also no frontend
contract to defer to: `src/lib/services/` has no search service, `src/types/`
has no search type, and the topbar's search input
(`src/components/app/app-topbar.tsx`) has no handler at all. The decisions
below were therefore made explicitly and ruled on before implementation
started; each is recorded here with its reasoning rather than left implicit in
a query.

---

## Architecture

```
GET /api/v1/search
        ↓  optionalAuth  → viewer identity from a verified token, or anonymous
        ↓  rate limiter  → stricter than the global /api budget (§28)
        ↓  Zod           → term normalized; type/sort parsed into closed unions
   search.controller     ← no logic; builds the viewer, calls the service
        ↓
   search.service        ← THE SearchService of §24
        ↓  five concurrent queries, skipping groups the filter excluded
   search.repository     ← the only Prisma caller; visibility applied IN SQL
        ↓
      PostgreSQL         ← ILIKE, no extension, no index, no migration
        ↓
   search.view           ← the sole projection chokepoint
        ↓
   grouped response
```

### The §24 abstraction is the service/repository seam

§24 asks for a _SearchService abstraction_, not a class. `search.service.ts`
knows search **semantics** — which groups a request wants, how a page maps onto
each group, what the response looks like. It knows nothing about how a row is
matched. Everything engine-specific lives one layer down.

Swapping PostgreSQL for Meilisearch replaces `search.repository.ts` and leaves
the service, the controller, the route, and the response shape untouched. That
is precisely what "without changing the API contract" requires.

**No port was introduced.** `ports/notification.port.ts` exists because _domain
services_ had to raise notifications without depending on the notifications
module — an inversion between peers. Nothing depends on search except HTTP, so
a port here would be a third layer with one implementation and no second
caller.

### Files

| File                                  | Role                                                 |
| ------------------------------------- | ---------------------------------------------------- |
| `modules/search/search.access.ts`     | Pure visibility rules + query normalization. No I/O. |
| `modules/search/search.repository.ts` | Every query. Nothing else touches Prisma.            |
| `modules/search/search.service.ts`    | The §24 SearchService.                               |
| `modules/search/search.view.ts`       | The only row-to-response projection.                 |
| `modules/search/search.schema.ts`     | Zod.                                                 |
| `modules/search/search.controller.ts` | HTTP adapter.                                        |
| `modules/search/search.routes.ts`     | `/api/v1/search` + the rate limiter.                 |
| `modules/search/search.types.ts`      | Response shapes.                                     |

---

## REST API

One route (**ruling D5**). §29 names `/api/v1/search` and nothing else, so the
entity filter is a query parameter rather than a path segment: one contract,
one rate limiter, one place where authentication is decided.

| Method | Path      | Auth           | Purpose                          |
| ------ | --------- | -------------- | -------------------------------- |
| GET    | `/search` | `optionalAuth` | Search all five entities at once |

There is deliberately **no `/search/users`, `/search/projects`, …**, no `POST`,
and no write of any kind.

### Query parameters

| Parameter | Default  | Notes                                                                |
| --------- | -------- | -------------------------------------------------------------------- |
| `q`       | required | Trimmed and whitespace-collapsed before validation                   |
| `type`    | `all`    | `all` \| `users` \| `projects` \| `communities` \| `posts` \| `tags` |
| `sort`    | `recent` | `recent` \| `popular` — no `relevance`                               |
| `page`    | `1`      | Applied to every group                                               |
| `limit`   | `20`     | Clamped at 100 rather than rejected                                  |

An unknown `type` or `sort` is a **422 at the edge**. Neither ever reaches the
database as a string: the schema parses them into closed unions and the
repository switches on the union to build an `orderBy`.

`limit` **clamps** rather than rejects — the one deliberate deviation from the
shared `offsetPaginationSchema`, which 422s an oversized page. `MAX_PAGE_SIZE`
and `DEFAULT_PAGE_SIZE` are reused unchanged, so the ceiling is defined once.

### Response

Grouped (**ruling D14**), with all five groups **always present**:

```jsonc
{
  "query": "react",       // the normalized term that actually ran
  "type": "all",
  "sort": "recent",
  "users":       { "items": [...], "pagination": { "page": 1, "limit": 20, "total": 3, "totalPages": 1 } },
  "projects":    { "items": [...], "pagination": { ... } },
  "communities": { "items": [...], "pagination": { ... } },
  "posts":       { "items": [...], "pagination": { ... } },
  "tags":        { "items": [...], "pagination": { ... } },
  "totalResults": 12      // sum of the five visible totals
}
```

A group excluded by `type` comes back **empty with a zero total**, not absent.
A client rendering five result tabs should never have to branch on whether a
key exists, and a stable shape lets OpenAPI describe one response instead of
six.

**An empty result is a 200, never a 404.** The query was understood and ran;
there was nothing visible to return. A 404 would also make "no results" and
"hidden results" distinguishable, which they must not be.

**Search has no 403.** Content is discoverable or absent. The whole point of
the visibility rules is to erase the difference between "hidden from you" and
"does not exist", and a 403 would restore it.

---

## Security model

Search is the widest read surface in the API: one request touches five tables,
each with visibility rules originally written for a single-domain listing. Its
security suite is correspondingly the largest in the phase.

### Visibility, in SQL

Every clause is applied **in the query**, never after fetching. Phase 5 recorded
why, and it is doubly true here: a post-fetch filter returns short pages _and_
reports a `total` that counts rows the viewer may not see — turning a paging
bug into a disclosure channel.

| Entity      | Rule                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| Users       | Not deleted; the target has not blocked the viewer; public profile, self, or a profile the viewer follows                |
| Projects    | Not deleted; the owner has not blocked the viewer; public, own, or a member's                                            |
| Communities | Same as projects                                                                                                         |
| Posts       | Not deleted; the author has not blocked the viewer; public or own; and the post's community must be public and undeleted |
| Tags        | Unconditional — curated taxonomy with no visibility, no soft delete, no owner                                            |

`unlisted` is excluded for non-members by construction: it means "reachable by
link, not by listing", and a search result **is** a listing.

Private-community posts are hidden **even from members**, matching the Phase 6
feed decision: a member reads their private community's posts on the community
page, which owns its own scoped listing. Widening here would mix
private-community content into a global surface.

Followers-only profiles are **absent**, not redacted. An identity-only shell in
a result set would still confirm that an account exists at a given handle,
which is what the setting exists to prevent.

### Where the rules live

`search.access.ts` holds pure predicates for all five entities; the SQL lives
in `search.repository.ts`. That mirrors `project.visibility.ts` ↔
`projects.repository.listVisibilityWhere` and is the same trade Phase 5 made:
the pure function is what the tests pin the rules to, the SQL is what keeps a
hidden row from consuming a page slot. `tests/search-repo.test.ts` asserts the
two agree on real rows, so they cannot drift silently.

The SQL side **reuses a domain helper wherever one is reachable**:
`posts.repository.listVisibilityWhere` and its community counterpart are both
exported and are called directly. `projects.repository.listVisibilityWhere` is
module-private, and Phase 10 may not modify a previous-phase file merely to
widen an export, so that one clause is re-expressed. Users never had a
set-level helper at all — `users/visibility.ts` decides one loaded profile at a
time and returns `full | redacted | not_found`, which cannot be pushed into a
`WHERE` — so that clause is new.

### Admins get nothing extra (ruling D8)

`projects.repository.listVisibilityWhere` and its community counterpart both
widen for admin roles. **Search does not.** Search is discovery, not
moderation; admin tooling is Phase 11.

This is enforced structurally rather than by a comment. `effectiveViewerRole()`
returns `null` for every input, and it is what the repository passes to both
reused helpers — so their admin branches cannot fire. The pure predicates take
no role parameter at all, so there is no branch that could grow one. Both
properties are asserted in the tests.

A consequence worth stating: a search result set can be **narrower** than what
the same admin sees on `/projects`. That is intended.

### Identity cannot be supplied by the client

Zod strips unknown keys, so `?userId=`, `?viewerId=`, `?actorId=`, `?role=`,
and `?isAdmin=` are discarded before the controller runs. The service has no
parameter that selects a different viewer, and only the viewer's **id** is
passed to the repository — the role is dropped in the service rather than
ignored downstream, so there is no argument an admin branch could read.

### Counts cannot leak

Each group runs its page query and its `COUNT` against **the identical `where`
object**, built once and shared. Two separately built clauses could drift, and
a total computed from a wider clause than the page would report the existence
of rows the viewer cannot see. Every hidden-row test in the security suite
asserts the count as well as the page.

---

## Query semantics (ruling D11)

A term is trimmed and whitespace-collapsed, then rejected if it carries no
search intent:

- **empty or whitespace-only** — the cases the ruling names;
- **wildcard-only** — `%`, `__`, `% %`. Syntactically non-empty, semantically
  "give me everything".

Matching is case-insensitive substring containment. There is **no** autocomplete,
no prefix matching, no fuzzy matching, and no suggestions — nothing in any
specification asks for them.

### Matched columns

| Entity      | Matched                   | Deliberately not matched          |
| ----------- | ------------------------- | --------------------------------- |
| Users       | `username`, `displayName` | `bio` — projected, never searched |
| Projects    | `title`, `description`    |                                   |
| Communities | `name`, `description`     |                                   |
| Posts       | `content`                 | `codeContent`                     |
| Tags        | `name`, `slug`            |                                   |

`bio` is projected because it makes a person-shaped result legible, but
searching it would make a bio a public index of its author, which is not what
PRD §15's "Users" asks for. `codeContent` is plausible on a builder platform,
but PRD §15 says "Posts" and nothing more; adding a second matched column is a
product decision this phase was not given.

### The LIKE wildcard limitation

**Prisma's `contains` does not escape `%` or `_`.** Verified against the running
database: `contains: "100%_x"` compiles to `ILIKE $1` with the bound parameter
`"%100%_x%"`. There is no `ESCAPE` clause available through the query API, and
ruling D2 forbids raw SQL, so they cannot be neutralized.

The consequence is bounded and worth stating plainly: a term containing `%` or
`_` **over-matches and never under-matches**. `snake_case` still finds
`snake_case` — an `_` matches an `_` — it merely also finds `snakeXcase`. That
is a loss of precision, **not a leak**: the visibility clause is a separate
`AND` that no wildcard can escape, and the value is parameterized, so this is
not SQL injection.

The one case that is more than imprecise is a wildcard-only term, which is
rejected for that reason. The limitation is pinned by a test rather than only
described here, so the day someone adds escaping the test fails and says so.

---

## Ordering and pagination

### No relevance ranking (ruling D6)

**No specification mentions ranking, relevance, scoring, or weighting** — not
PRD §15, not TRD §24, not ARCHITECTURE §24. And there would be nothing to
compute a score from: ruling D2 pins matching to `ILIKE`, which yields a
boolean, not a rank.

Sorting is therefore explicit, deterministic, and allow-listed:

| Sort      | Users       | Projects     | Communities   | Posts        | Tags         |
| --------- | ----------- | ------------ | ------------- | ------------ | ------------ |
| `recent`  | `createdAt` | `createdAt`  | `createdAt`   | `createdAt`  | `createdAt`  |
| `popular` | `xp`        | `likesCount` | `memberCount` | `likesCount` | `usageCount` |

All descending, and **every ordering ends in `id DESC`**. Without that tie-break,
rows sharing a `createdAt` millisecond or a `likesCount` have no defined order,
and offset paging would be free to show one row twice and skip another. Phase 9
broke its cursor ties the same way.

Most of these columns are already indexed by the Phase 2 schema —
`users(xp DESC)`, `projects(visibility, deletedAt, likesCount DESC)`,
`posts(deletedAt, likesCount DESC)`, and `tags(usageCount DESC)`, the last of
which was added for this phase and had no consumer until now.

### Offset, not cursor (ruling D7)

TRD §8 permits either and prefers cursor for high-volume collections, but two
repository-internal sources name search specifically as an offset case:
`utils/pagination.ts` ("Offset — for stable, page-numbered lists (admin tables,
search)") and `docs/DATABASE.md`.

There is also a structural reason: a cross-entity result set has **no single
cursor column** — five tables, five id spaces — so a cursor could not address
it. `offsetPaginationSchema`'s helpers (`toPrismaOffset`, `buildPagination`,
`MAX_PAGE_SIZE`, `DEFAULT_PAGE_SIZE`) are reused.

`page` and `limit` apply to **every group**. That is what a grouped response
means: page 2 of a search is page 2 of each entity, not page 2 of an interleaved
list — which would need the cross-entity ranking ruling D6 forbids inventing.

---

## Rate limiting

ARCHITECTURE §28 lists Search under "Stricter limits" and separately under
"Public APIs vulnerable to abuse". Both readings point the same way: one search
request runs five unindexed substring scans, making it the most expensive
anonymous read in the API.

"Stricter" is expressed **relative to the configured baseline** — 30% of
`RATE_LIMIT_MAX`, with a floor of 5 — rather than as an absolute number. At the
shipped baseline of 100/minute that is 30/minute: one search every two seconds,
which no human typing in a box will notice, and roughly a third of a scraper's
throughput. A deployment that tunes the global limit moves search with it
instead of leaving it pinned to a constant that silently drifts out of
proportion. No new environment variable was required.

### Known defect (ruling D13) — fixed in Phase 15

`rate-limit.middleware.ts` gave **every** limiter the same Redis key prefix,
`rl:`, and `express-rate-limit` keys on the client IP, so the `name` passed to
`createRateLimiter` reached the log line and nothing else.

The search limiter therefore **shared a counter** with the global `/api` limiter
and with `auth-credentials` for the same IP: the tightest budget won for all of
them, requests to unrelated endpoints consumed search's allowance, and the first
limiter to create the key fixed the window for the rest.

The defect dated from Phase 2 and was out of scope for Phase 10, which could not
edit a previous-phase middleware. Phase 15 — the final cross-cutting hardening
phase — namespaced the store per limiter (`rl:<name>:`). The budgets described
above are now the budgets that actually apply.

---

## Redis, jobs, and sockets

**No Redis caching** (ruling D12). ARCHITECTURE §20 lists search results as a
_potential_ cache target and closes with "Do not introduce caching where it
complicates correctness without measurable benefit". Search results are
viewer-dependent — visibility, blocking, followers-only profiles — so any cache
key would have to include viewer identity, which mostly destroys the hit rate
while adding a leak vector. Redis is used for the rate limiter and nothing else.

**No background jobs.** `bullmq` is not installed, TRD §25 makes job
infrastructure optional, and search is a read path with no fan-out.

**No Socket.IO.** Nothing in PRD §15, TRD §24, or ARCHITECTURE §14 asks for
real-time search. No handler is registered and no event is documented; a test
asserts that no `search*` event exists.

---

## The rulings, in full

| #   | Ruling                   | Decision                                                                                                                                                                   |
| --- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Scope                    | **Search only.** No achievements, despite nine repository comments and `modules/README.md` assigning the awarding engine to Phase 10 — ARCHITECTURE §38 names only Search. |
| D2  | Engine                   | PostgreSQL `ILIKE` via Prisma `contains`. No FTS, `pg_trgm`, GIN, `tsvector`, extensions, raw SQL, or migrations.                                                          |
| D3  | Entities                 | Exactly five: users, projects, communities, posts, tags.                                                                                                                   |
| D4  | Authentication           | `optionalAuth`. Anonymous sees public content; authenticating widens evaluation, never authority.                                                                          |
| D5  | Endpoint shape           | One route, `GET /api/v1/search`, with a `type` filter.                                                                                                                     |
| D6  | Ranking                  | None. Deterministic allow-listed sorting only.                                                                                                                             |
| D7  | Pagination               | Offset, per group, reusing the existing utilities.                                                                                                                         |
| D8  | Admin visibility         | No widening. Search follows ordinary discovery rules.                                                                                                                      |
| D9  | The community `q` filter | Left completely unchanged.                                                                                                                                                 |
| D10 | Free-text tags           | Not implemented. Tags remain curated taxonomy.                                                                                                                             |
| D11 | Query validation         | Non-empty trimmed term required; whitespace-only and wildcard-only rejected. No autocomplete or fuzzy matching.                                                            |
| D12 | Caching                  | None.                                                                                                                                                                      |
| D13 | Rate limiting            | Stricter limiter added; the `rl:` prefix collision documented here and fixed in Phase 15.                                                                                  |
| D14 | Response shape           | Grouped, all five keys always present, projection-safe.                                                                                                                    |

---

## Test coverage

| Suite                     | Tests | Subject                                                                                                                                                                                                                                                                                          |
| ------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `search-unit.test.ts`     | 59    | Query normalization and the wildcard rules; the full visibility matrix per entity, exhaustive for users; type/sort allow-lists; the admin guard                                                                                                                                                  |
| `search-repo.test.ts`     | 37    | Real PostgreSQL: every visibility rule against real rows with the pure predicate asserted alongside; hidden rows absent from totals; matched-column boundaries; offset paging stability; case-insensitivity; the documented wildcard limitation                                                  |
| `search.test.ts`          | 28    | All five entities from one endpoint; the grouped contract; type filter; sort allow-list; clamping; 422s; 200-with-empty-groups; envelope and projection                                                                                                                                          |
| `search-security.test.ts` | 18    | Private and unlisted projects, private communities, followers-only profiles, non-public posts, private-community posts, blocking in both directions, admin parity across three roles, spoofed identity and role, forged tokens, projection safety, no 403, hidden-vs-absent indistinguishability |
| `openapi.test.ts`         | +11   | One path only; schemas; read-only; optional auth; no 403/404; 429 documented; parameter and enum coverage; no excluded entity type; projection safety; no socket event                                                                                                                           |

---

## Intentionally deferred

| Deferred                                                         | Owner / reason                                    |
| ---------------------------------------------------------------- | ------------------------------------------------- |
| **Achievements / the awarding engine**                           | Unassigned — ARCHITECTURE §38 gives it no phase   |
| **Cross-conversation message search**                            | Not in PRD §15 or TRD §24; Phase 8 scoped its own |
| **Notification search / filtering by type**                      | Not in either entity list; Phase 9 scoped its own |
| **Comment search**                                               | Not an entity in either list                      |
| **Elasticsearch / OpenSearch / Meilisearch**                     | Explicitly _future_ in both §24s                  |
| **`pg_trgm`, GIN, `tsvector`, generated columns**                | Would require a migration                         |
| **Relevance ranking, autocomplete, suggestions, fuzzy matching** | Named in no specification                         |
| **Admin-scoped or moderation-aware search**                      | Phase 11                                          |
| **Uploads / file-content search**                                | Phase 11                                          |
| **Recommendations**                                              | Out of scope entirely                             |
| **Background reindexing jobs**                                   | No queue installed                                |
| **Redis result caching**                                         | Correctness cost exceeds the benefit              |
| **Free-text tag creation**                                       | Would make `Tag` unbounded — the J7/J8 decision   |

---

## Known limitations

1. **`ILIKE '%term%'` cannot use a B-tree index** and is a sequential scan. This
   is the same trade Phase 7's community `q` filter and Phase 8's message search
   already make. Raising the ceiling needs a GIN index, which needs a migration,
   which is a decision above this phase.
2. **LIKE wildcards in a term over-match**, as described above.
3. **`Profile` carries no index**, yet `Profile.visibility` gates user search.
   Adding one is a migration.
