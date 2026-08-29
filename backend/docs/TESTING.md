# Testing & Hardening

Phase 13. A quality and regression pass across Phases 1–12 — `BACKEND_TRD.md`
§32, `BACKEND_ARCHITECTURE.md` §35, and the roadmap entry at
`BACKEND_ARCHITECTURE.md` §38 that names this phase **Testing**.

No product functionality was added. One defect was found and fixed.

## What the specifications ask for

| Source                        | Requires                                                                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BACKEND_TRD.md` §32          | coverage of authentication, authorization, validation, services, repositories, API endpoints, database behaviour, messaging, socket events, moderation, and critical security paths; Vitest + Supertest; _"Critical functionality should have integration tests."_ |
| `BACKEND_ARCHITECTURE.md` §35 | unit, service, repository, API integration, authentication, authorization, socket, and **critical end-to-end** layers; _"Prioritize tests for security-sensitive functionality."_                                                                                  |
| `BACKEND_ARCHITECTURE.md` §38 | Phase 13 is **Testing**                                                                                                                                                                                                                                            |

## The gap this phase closed

Phases 1–12 left 55 suites and 1,714 tests. Coverage of each module in
isolation was strong. Two things nothing tested:

1. **The contract against the code.** `openapi.test.ts` audits the OpenAPI
   _document_ — its schemas, its projections, its absent future-phase paths.
   Nothing compared it to the router that actually exists, so a route could be
   mounted and undocumented, or documented and never mounted, and every test
   would still pass.

2. **The seams between modules.** ARCHITECTURE §35 names _"Critical end-to-end
   tests"_ as a layer, and there were none. Every suite tested its own module;
   none tested the product — a follow in Phase 4 arriving in a Phase 9 inbox, a
   Phase 11 report removing a Phase 6 post, a Phase 3 middleware enforcing a
   Phase 11 ban.

## The defect: a 500 from a query string

**Severity: moderate. Found, fixed, and regression-tested in this phase.**

Any caller could produce a 500 from the API with a malformed pagination
cursor:

```
GET /api/v1/feed?cursor=%FF%FF   →   500 Internal Server Error
```

### Root cause

`cursor` was validated as `z.string().min(1)` — non-empty, nothing more. The
value was then handed to Prisma as `cursor: { id: cursor }`. Every id this API
pages over is a `@db.Uuid` column, so PostgreSQL rejected the malformed uuid,
and `error.middleware.ts` maps only `P2002` and `P2025` — everything else
falls through to a 500.

The codebase had already decided this was wrong, twice, in writing:

- `posts.schema.ts` on path params — _"a malformed id is a **422** rather than
  a database trip."_
- `messages.schema.ts` on its own uuid helper — guarding against _"a Prisma
  error surfacing as a 500."_

Phase 8 and Phase 9 applied that rule to their cursors (`cursor:
uuid.optional()`). Phase 5, 6, 7 and the shared `utils/pagination.ts` did not.

### Impact

Every cursor-paged endpoint outside messaging and notifications: the feed,
post comments, comment replies, community lists and child collections,
bookmarks, project changelogs, and both follow lists — seven endpoint families
over 14 repository call sites. A 500 is the wrong answer to bad input: it
tells the caller nothing actionable, and it turns a query string into a way to
generate error-monitor noise at will. It is not an authentication,
authorization, or data-integrity failure — no request succeeded that should
have failed.

### Fix

Six schema definitions, applying the convention the codebase already used:

| File                             | Schema                                                   |
| -------------------------------- | -------------------------------------------------------- |
| `utils/pagination.ts`            | `cursorPaginationSchema` (shared; used by follows)       |
| `modules/posts/posts.schema.ts`  | `feedQuerySchema`, `cursorQuerySchema`                   |
| `modules/projects/…schema.ts`    | `cursorQuerySchema`                                      |
| `modules/communities/…schema.ts` | `communityListQuerySchema`, `communityCursorQuerySchema` |

`z.string().min(1)` → `z.string().uuid("Invalid cursor")`. No route, service,
repository, or response shape changed; the validation middleware turns the
failure into the 422 every other malformed parameter already produced.

**A well-formed cursor that matches no row is still an empty page, not an
error** — asserted explicitly, because a fix that rejected unknown-but-valid
cursors would have broken paging rather than hardened it.

## Tests added

Three files, 35 tests. Every one covers a security boundary, a contract, an
integration path, or the regression above; none was added to move a number.

### `tests/contract.test.ts` — 7 tests

Reconciles the OpenAPI document against the routers `routes/index.ts` actually
mounts, in **both** directions, because they fail differently:

- **mounted but undocumented** is a surface nobody reviewed — the
  "accidentally exposed route" case;
- **documented but not mounted** is a 404 in every generated client.

It walks each module router with its known mount prefix and reads
`layer.route.path`. It deliberately does **not** parse Express's internal
path-matching regexes, which changed between Express 4 and 5 and would make
the test a liability instead of a guard. A third test asserts the walk found
more than 100 operations, so the two set comparisons cannot pass vacuously.

Also pinned here: every documented path sits under a root
`ARCHITECTURE.md` §29 names; no `/ai`, `/achievements`, or `/uploads` route is
mounted; and every mutating operation declares authentication.

**Result: no drift.** 132 mounted operations, 132 documented, both directions
empty.

The auth assertion carries two deliberate exceptions, enumerated rather than
pattern-matched so a third is a decision someone makes on purpose:
`/auth/*` (you cannot present a bearer token before you have one) and
`POST /projects/{slug}/view`, which is `optionalAuth` by design because
_"anonymous visitors are most of a public project's audience"_. A companion
test asserts that exception is still real, so it cannot rot into a stale
excuse.

### `tests/hardening.test.ts` — 15 tests

The properties that must hold _everywhere_, which no module suite owns.

- **The cursor regression.** Every cursor endpoint answers 422 for six shapes
  of bad cursor, and still answers 200 for a well-formed one.
- **No 5xx from user input**, across thirteen probes spanning posts, comments,
  feed, search, projects, and communities.
- **Authentication boundaries.** 401 for sixteen protected reads with no
  token; 401 — never 500 — for five shapes of malformed token; and a token
  passed in the query string is not accepted, because tokens in URLs end up in
  access logs and `Referer` headers.
- **Account status across modules.** A ban is decided in Phase 11 and enforced
  by Phase 3 middleware, so it must be felt by every phase in between:
  refused on eight authenticated reads and three write paths; **degraded to
  anonymous** rather than privileged on `optionalAuth` routes; invisible to a
  shadow-banned account, which stays fully functional; and lifted
  automatically when a temporary suspension has expired, on the very request
  that would otherwise have been refused.
- **Error envelope uniformity** — `{ success: false, data: null, error: { code,
message } }` — and three distinct error codes for 401/404/422, so a client
  can tell "log in again" from "that is gone".

### `tests/e2e.test.ts` — 13 tests

The critical end-to-end path ARCHITECTURE §35 asks for: one narrative in
order, where each step builds on the last, so a failure names the seam that
broke.

> An author registers, ships a project, and posts. A reader follows, likes,
> and comments — each arriving in the author's inbox through the notification
> port, without Phases 4 or 6 knowing Phase 9 exists. The two hold a private
> conversation a third party cannot address. Search finds the project without
> leaking an email. The reader files a report; a moderator claims it, removes
> the post, and the audit row is written in the same transaction while the
> author is notified with no actor attached. Only a platform admin can read
> the trail, and there is no write route to find. A block silences the
> blocker's inbox. A ban takes effect on the very next request. The report is
> closed, and reopening a terminal report is a 409.

Two house rules are pinned in passing because this is where they are most
easily broken: a visibility refusal is a **404, not a 403** (ARCHITECTURE
§18), and `passwordHash` appears in no response on any phase's endpoint.

Every assertion is scoped to fixtures the file created. Suites run in parallel
against one database, so a global row count is a race, not an assertion — a
lesson this project already learned in Phase 11.

## Known technical debt — verified, classified, not fixed

Each was re-verified against the current tree. None was fixed, because none is
in Phase 13's authoritative scope and the instruction was explicit that
noticing debt is not a licence to change it.

| #   | Debt                                                | Still present                                                                   | Severity      | Should Phase 13 fix it?                                                                                                                                                                     |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Shared Redis rate-limit prefix `rl:`                | **Yes** — `rate-limit.middleware.ts` sets one `prefix: "rl:"` for every limiter | Moderate      | **No.** Fixing it changes throttling behaviour, which is a Phase 2 contract, not a test defect.                                                                                             |
| 2   | Search `contains` does not escape `%` and `_`       | **Yes** — `search.repository.like()` passes the term straight into `ILIKE`      | Low           | **No.** A wildcard-only query is already rejected by `isEffectivelyEmpty`; a mixed term like `a%` still widens the match. Escaping changes search semantics — a Phase 10 contract decision. |
| 3   | Load-bearing 30s Vitest timeout                     | **Yes** — `vitest.config.ts`                                                    | Informational | **No.** It is documented, deliberate, and caused by real Argon2id cost under parallel forks. `vitest.config.ts` is frozen.                                                                  |
| 4   | Flaky `auth-unit` tampered-ciphertext test          | **Yes** — `auth-unit.test.ts:345` still builds `` `A${data.slice(1)}` ``        | Low           | **No.** Pre-existing Phase 3 debt, measured at ~1.57% (47/3000), untouched by Phase 13.                                                                                                     |
| 5   | `AI_PROVIDER` not forwarded by `docker-compose.yml` | **Yes** — compose forwards `EMAIL_PROVIDER` but not `AI_PROVIDER`               | Low           | **No.** `docker-compose.yml` is a frozen path. The default (`local`) is safe; the consequence is that a containerised deployment cannot select `disabled`.                                  |

## Audits that found nothing

Reported because a clean result is a finding, and because "we looked" is worth
recording:

- **Route contract** — 0 undocumented routes, 0 unmounted documented routes.
- **Unauthenticated access** — every protected route answers 401.
- **AI regression boundary** (Phase 12 frozen) — no product module imports
  `integrations/ai`, no `/ai` route is mounted, no automatic moderation action
  exists, and `src/jobs/` is still empty.
- **Dead code and hygiene** — no `console.*` logging in `src/`, no
  `TODO`/`FIXME`/`HACK`, no `.only`/`.skip`/`.todo` in any suite, no committed
  secret, no abandoned generated file.
- **Dependencies** — diff of 0. No AI SDK, no queue library, nothing added.
- **Unbounded queries** — the four `findMany` calls without a `take` are each
  naturally bounded: one user's sessions, one user's notification preferences
  (one row per enum member), and the username-suffix prefix scan. Only the last
  is theoretically unbounded, and it is inherent to how a free handle is
  chosen. Recorded as an observation, not a defect.

## Deferred risks

Recorded rather than acted on, each because acting would exceed Phase 13.

- **Concurrency.** Phases 5, 6, and 9 each ship their own concurrency suite
  (`projects-concurrency`, `posts-concurrency`, and the counter tests in
  `notifications-repo`), and the guarded-`updateMany` pattern is used
  consistently for status and counter writes. No race was found that could be
  fixed inside the frozen schema; none required a new unique constraint.
- **Performance.** No N+1 was found in a read path — the projection layer
  selects explicitly and pages are bounded. `ILIKE '%term%'` in search remains
  a sequential scan by design (Phase 10 ruling D2, documented in `SEARCH.md`),
  and fixing it needs a `pg_trgm` index, therefore a migration.
- **Socket coverage.** `socket-auth`, `messages-socket`, and
  `notifications-socket` cover handshake authentication, room isolation,
  impersonation attempts, and delivery. Reconnect-storm and multi-node
  behaviour are not covered; both need infrastructure this phase may not add.

## Remaining production risks

1. **Rate limiting is one shared counter** (debt 1). Under a real load
   profile, a burst against one endpoint family consumes budget for others.
2. **Shadow ban is recorded but not enforced** — Phase 11 ruling R3, unchanged.
3. **No background jobs** — Phase 12 recorded this; every AI call, were one
   wired, would be synchronous.
4. **Search is a sequential scan** and will degrade with row count long before
   anything else does.
5. **One flaky test** (debt 4) will occasionally redden a clean run. Re-run
   before investigating.

## Validation

| Suite     | Files  | Tests     | Failures | Skipped |
| --------- | ------ | --------- | -------- | ------- |
| Before    | 55     | 1,714     | 0        | 0       |
| **After** | **58** | **1,749** | **0**    | **0**   |

| Gate                        | Result                       |
| --------------------------- | ---------------------------- |
| `npm run typecheck`         | exit 0                       |
| `npm run build`             | exit 0                       |
| `npx prisma validate`       | valid                        |
| `npx prisma migrate status` | up to date, **2 migrations** |
| `prettier --check .`        | clean repo-wide              |
| `git diff --check`          | no whitespace errors         |
| Dependency diff             | **0**                        |

Schema, migrations, and seed are untouched.
