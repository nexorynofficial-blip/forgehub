# Administration

Phase 11. User management, analytics, and the audit trail —
`BACKEND_PRD.md` §18, `BACKEND_TRD.md` §29, `BACKEND_ARCHITECTURE.md` §26, §29.

The moderation workflow — reports and the actions taken on them — is the sibling
module and is documented in [MODERATION.md](MODERATION.md). They are separate
because `ARCHITECTURE.md` §29 names two API roots, and keeping them apart is
what lets the two routes that need `platform_admin` be gated without dragging
the whole moderation queue up with them.

## What PRD §18 asks for, and what this phase serves

§18 lists seven administrator capabilities:

| Capability           | Where it lives                                                                     |
| -------------------- | ---------------------------------------------------------------------------------- |
| User management      | `GET /admin/users`, `PATCH /admin/users/:id/role`, `PATCH /admin/users/:id/status` |
| Content moderation   | `POST /moderation/actions` — the sibling module                                    |
| Reports              | `GET /moderation/reports` — the sibling module                                     |
| Analytics            | `GET /admin/stats`, `GET /admin/analytics/*`                                       |
| Audit logs           | `GET /admin/audit-logs`                                                            |
| Community management | **not in this phase** — see below                                                  |
| Project management   | **not in this phase** — see below                                                  |

Community and project administration have **no endpoint contract anywhere**: the
shipped frontend has no admin surface for either, the specifications name no
routes, and inventing a CRUD surface for them would be inferring a requirement
rather than meeting one. Reports may still target projects and communities, and
staff can review and action those reports.

## No schema change

Phase 11 added **no models, no columns, and no migration**. The migration count
is still **2**. The analytics endpoints read counters Phase 2 already
denormalized onto `User` and count rows through existing indexes.

## Endpoints

| Method  | Path                                        | Who                        |
| ------- | ------------------------------------------- | -------------------------- |
| `GET`   | `/api/v1/admin/users`                       | `requireAdmin`             |
| `PATCH` | `/api/v1/admin/users/:id/role`              | **`requirePlatformAdmin`** |
| `PATCH` | `/api/v1/admin/users/:id/status`            | `requireAdmin`             |
| `GET`   | `/api/v1/admin/stats`                       | `requireAdmin`             |
| `GET`   | `/api/v1/admin/analytics/signups`           | `requireAdmin`             |
| `GET`   | `/api/v1/admin/analytics/reports-by-reason` | `requireAdmin`             |
| `GET`   | `/api/v1/admin/audit-logs`                  | **`requirePlatformAdmin`** |

`requireAuth` always precedes the role guard, so an anonymous caller gets 401 and
an authenticated-but-unauthorized one gets 403. Reversing them would answer "who
are you?" with "you may not", which `ARCHITECTURE.md` §18 warns against
conflating.

Both middlewares are Phase 3 code that, until now, was mounted on no route at
all — `tests/auth-security.test.ts` exercised them against a throwaway router.
This is their first production use.

## The two `platform_admin` routes

These are the two places the backend is **deliberately stricter than the shipped
frontend**, and each closes a real hole.

### `PATCH /admin/users/:id/role`

`user-row.tsx` renders a role `<Select>` containing `platform_admin` to anyone
who reaches the admin page, and its `updateUserRole` mock has no guard at all.
Mirroring that server-side with `requireAdmin` would let **any moderator promote
themselves to platform admin** — the worst outcome available in this phase.

The server refuses. The frontend's control simply 403s for non-platform admins,
which is the correct direction for the two to disagree in.

Four rules, all in `moderation.access.canChangeRole` and all pinned across every
role pairing in `tests/moderation-unit.test.ts`:

1. **`platform_admin` only.** A moderator or community admin cannot change
   anyone's role, so neither can promote anyone.
2. **Never your own role.** Otherwise the rank rule is trivially defeated by
   promoting yourself first.
3. **Never an equal or higher rank** — so no platform admin can promote or
   demote another platform admin.
4. **`guest` is never assignable.** It is the frontend's not-signed-in
   sentinel, never written to the database, and an account holding it would fail
   every authorization check in confusing ways.

The write is guarded on the role the caller observed, so two simultaneous
changes conflict (409) rather than silently overwriting one another. Audited as
`ROLE_CHANGED` in the same transaction, with `{ from, to }` in the metadata.

### `GET /admin/audit-logs`

The trail records every login, password change, role change, moderation action,
IP address, and user agent on the platform — the single most sensitive read
surface in the API. `TRD.md` §29 requires it not be _editable_ by normal users;
this restricts _reading_ to the one role that needs it, so a moderator reviewing
reports cannot pull the login history of the people they moderate.

## User management

`GET /admin/users` returns the shipped `AdminUserSummary` shape exactly:
`{ user, role, status, joinedAt, projectsCount, followersCount }`, with the
person as the same five-field projection the rest of the API uses.

Standing sits **beside** the person rather than inside it. That is not
cosmetic: `AdminUserView` is the ordinary person shape, and keeping `role` and
`status` out of it means no other surface can start serving a role by reusing
the projection.

Newest account first, tie-broken by id so offset paging is total-ordered — the
seed inserts its users in one pass and several share a millisecond. Soft-deleted
accounts are excluded; they cannot be moderated into any meaningful state and
would fill the table with tombstones.

### `email` is deliberately absent

It is the one field an administrator might plausibly expect here and the one
this projection will not serve:

- the shipped table does not render it;
- `users/visibility.canSeeEmail` governs who may see an address and is not
  consulted by this module;
- a paginated table of every account's email is a credential-stuffing target
  that no listed requirement asks for.

An administrator who needs one address opens that user's profile, where the
existing rule applies. `tests/admin.test.ts` asserts no `@` address appears in
the response.

### There is no search parameter

`PRD.md` §18 asks for "User management" and the shipped `getAdminUsers()` takes
no arguments, so a free-text `q` would be inferring a requirement — and building
a second user-search surface a phase after Phase 10 ruled how user search works
would be the wrong way to add one. The `role` and `status` filters exist because
the table renders both columns and both are indexed enum equality rather than a
scan.

This is a **known limitation**: a user-management table without search is
awkward at scale. It is called out rather than quietly added.

## Status changes

`PATCH /admin/users/:id/status` takes a _state_ — `active`, `banned`,
`shadow_banned` — because that is what the shipped `updateUserStatus(userId,
status)` sends. Moderation records _verbs_, so the state is translated:

| From → to                  | Verb recorded | Basis                       |
| -------------------------- | ------------- | --------------------------- |
| any → `banned`             | `ban`         | named by `ARCHITECTURE` §25 |
| any → `shadow_banned`      | `shadow_ban`  | schema enum only            |
| `banned` → `active`        | `unban`       | **inference** — see below   |
| `shadow_banned` → `active` | `reinstate`   | **inference** — see below   |

The shipped table renders a single **Restore** button for both non-active
statuses and sends only `status: "active"`, never a verb — so the server has to
choose one of the two restoration members, and **no authoritative source says
which**. The last two rows are therefore an _implementation inference_, not a
specified requirement; the sources checked and the reasoning are recorded in
[`MODERATION.md`](./MODERATION.md#unban-and-reinstate--an-implementation-inference-not-a-requirement).
The first two rows are not an inference — the target status names the verb.

The route then **delegates entirely** to `moderation.service.applyStatusChange`.
That is the point: there is exactly one code path that writes `User.status`, and
it is the one that writes the `ModerationAction` and the `AuditLog` in the same
transaction. An admin-table ban and a `POST /moderation/actions` ban produce
identical rows.

The same rank rules apply, including the refusal to act on yourself. Setting the
status an account already holds is a **409** — a moderation action that changed
nothing is noise in a trail whose value comes from every row meaning something.

There is no `expiresAt` here. A _temporary_ suspension is a verb with its own
requirements and is filed through `POST /moderation/actions`.

## Analytics

Exactly the three endpoints the shipped frontend calls, and nothing more. No
warehouse, no aggregation jobs, no Redis caching — `ARCHITECTURE.md` §20's cache
list does not include analytics and adds _"Do not introduce caching where it
complicates correctness without measurable benefit."_

### `GET /admin/stats`

The four counters `getOverviewStats()` expects: `totalUsers`, `totalProjects`,
`totalCommunities`, `pendingReportsCount`. Four parallel `count()` queries
across four tables. Soft-deleted rows are excluded so the numbers describe live
content — a "total projects" that counted deleted projects would disagree with
every list in the product.

### `GET /admin/analytics/signups`

Eight weekly buckets ending with the current week, oldest first — the series the
shipped growth chart plots, with `weekLabel` in the `"Jun 9"` format
`mockWeeklySignups` uses.

Buckets are **half-open and aligned to UTC midnight**, so a signup falls in
exactly one bucket regardless of the deployment's timezone. Local-midnight
boundaries would silently move every count when the region changed. The label is
formatted with a pinned `en-US`/UTC formatter for the same reason.

Computed as **eight indexed range counts** on `users(createdAt)`, run in
parallel. Not raw SQL: PostgreSQL's `date_trunc` would express this in one
statement, but raw SQL is not something this phase introduces, and eight indexed
counts are not the bottleneck on a page that loads once. Not an in-memory
bucketing either, which would fetch every signup of the last two months.

`signupWeekBuckets` is pure and takes `now` as an argument, so
`tests/moderation-unit.test.ts` pins the boundaries rather than racing the clock.

### `GET /admin/analytics/reports-by-reason`

Counts by `ReportReason`. Reasons with a zero count are omitted, matching the
shipped chart's own `.filter((row) => row.count > 0)` — an empty bar renders as
a label with no mark and reads as a rendering bug.

## The audit trail

### Append-only

`TRD.md` §29: _"Audit logs must not be editable by normal users."_ This is
enforced by there being **no editor at all, for any user**:

- `repositories/audit.repository.ts` exports exactly `insertAuditLog` and
  `listAuditLogs`. No update, no delete.
- No route writes a record directly. `POST`, `PATCH`, `PUT`, and `DELETE`
  against `/admin/audit-logs` all 404 from the router.
- The OpenAPI document declares only `get` on that path, so the contract does
  not advertise an editor the code does not have.

`tests/audit.test.ts` asserts all three, including that the repository's export
list contains nothing matching `/update|delete|remove|edit/i`.

### Reading

Newest first, tie-broken by id — a moderation action and its own audit record
are frequently written in the same millisecond. Filters are exact matches on
indexed columns: `audit_logs(actorId, createdAt)`, `(action, createdAt)`, and
`(targetType, targetId)` all exist in the schema. `action` is a free string
because the column is, bounded to 64 characters so a filter cannot become a
pathological scan.

`ipAddress` and `userAgent` are served because they are the point of an audit
trail and this endpoint is `platform_admin`-only. `metadata` passes through as
stored; `utils/audit.ts` forbids credentials from reaching it, which is where
that rule belongs — a projection cannot retroactively redact a secret that was
already written.

### Durability

Moderation mutations and their audit rows commit together. See
[MODERATION.md](MODERATION.md#audit-is-transactional) for the mechanism and the
rollback test that proves it.

## Module dependencies

```
admin ──► moderation   (access rules, the transactional write, report counts)
admin ──► repositories/audit
```

The arrow never runs the other way. `moderation.access.ts` holds
`canChangeRole`, `canActOnUser`, and `actionForStatusChange` — all three are the
same rules whether a moderator invokes them through `/moderation/actions` or an
administrator through `/admin/users/:id/status`, and a second copy in the admin
module is exactly the drift the pure-predicate discipline exists to prevent.

`admin.repository.ts` deliberately has **no status write and no role-status
mutation**. It reads, and it owns one write — `updateUserRole` — because a role
change has no moderation verb to express it and so carries its own transaction
with its own audit insert, on the same all-or-nothing terms.

## Known limitations

- **No user search on the admin table**, above.
- **No community or project administration**, above.
- **The `rl:` rate-limiter prefix collision** (Phase 2) affects every limiter in
  the API, including any that guards these routes. Documented in
  [MODERATION.md](MODERATION.md#known-limitation-the-rl-prefix-collision) and
  deliberately not fixed.
- **Analytics are computed per request.** No caching, by design. The counts are
  indexed and the page loads once; if this ever becomes hot, `ARCHITECTURE.md`
  §20 is where the decision to cache belongs.
- **Admin reads do not widen content visibility.** Phase 10's ruling D8 stands:
  a platform admin gets exactly the search results an ordinary member gets, and
  `tests/moderation-security.test.ts` pins it.

## Explicitly not in this phase

Achievements · uploads · Cloudinary · AI moderation or classification · email
delivery · BullMQ or any job queue · background workers · an analytics warehouse
· appeals · Elasticsearch, Meilisearch, or OpenSearch · search ranking · Redis
caching · new socket events · frontend changes.

## Tests

| File                            | Covers                                              |
| ------------------------------- | --------------------------------------------------- |
| `tests/admin.test.ts`           | every endpoint, against the shipped frontend shapes |
| `tests/admin-security.test.ts`  | role escalation, audit access, injection            |
| `tests/moderation-unit.test.ts` | `canChangeRole`, capability tiers, week buckets     |
| `tests/audit.test.ts`           | append-only, vocabulary, transactional durability   |
| `tests/openapi.test.ts`         | route registration, schemas, 401/403/404/409        |
