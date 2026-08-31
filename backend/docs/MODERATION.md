# Moderation

Phase 11. Reports, the review queue, and the seven moderation actions —
`BACKEND_PRD.md` §17, `BACKEND_TRD.md` §28, `BACKEND_ARCHITECTURE.md` §25.

`ARCHITECTURE.md` §25 draws the flow this module implements end to end:

```
User → Report → Report Service → Moderation Queue → Moderator
     → Moderation Action → Audit Log
```

Administration — user management, analytics, and reading the audit trail — is
the sibling module and is documented in [ADMIN.md](ADMIN.md). The two are
separate because §29 names two API roots, and keeping them apart is what lets
role changes and audit reads be gated more tightly than the moderation queue.

## No schema change

Phase 11 added **no models, no enum members, no columns, and no migration**.
The migration count is still **2**. Everything the specifications ask for was
already migrated in Phase 2: `Report`, `ModerationAction`, `AuditLog`,
`User.role`, `User.status`, and the enums `ReportTargetType`, `ReportReason`,
`ReportStatus`, `ModerationActionType`, `ModerationStatus`, and `EntityType`.

Two schema details are load-bearing and worth naming, because the design
follows from them rather than from a choice made in this phase:

- **`ModerationStatus` has three members and none of them is `suspended`.**
- **`ModerationAction.expiresAt`** is documented in the schema as _"Set for
  temporary suspensions; null means permanent."_

So a temporary suspension is `(status = banned, expiresAt = <future>)` and a
permanent ban is `(status = banned, expiresAt = null)`. Both stop the account
authenticating; only the first lapses on its own.

## Endpoints

| Method  | Path                             | Who                    |
| ------- | -------------------------------- | ---------------------- |
| `POST`  | `/api/v1/moderation/reports`     | any authenticated user |
| `GET`   | `/api/v1/moderation/reports`     | `requireAdmin`         |
| `GET`   | `/api/v1/moderation/reports/:id` | `requireAdmin`         |
| `PATCH` | `/api/v1/moderation/reports/:id` | `requireAdmin`         |
| `POST`  | `/api/v1/moderation/actions`     | `requireAdmin`         |

`requireAdmin` is the Phase 3 middleware and admits `moderator`,
`community_admin`, and `platform_admin`. Phase 11 is its first production use;
until now it existed and was mounted on no route.

There is no `optionalAuth` anywhere in this module. An unattributed report is
not actionable, and an anonymous report queue would be a directory of everyone
under review.

## Authorization

### 403 for capability, 404 for existence

`ARCHITECTURE.md` §18 is explicit: an authorization failure is **403 Forbidden**.
Phases 5–10 answered visibility refusals with 404 instead, deliberately, because
there "may you see this?" and "does this exist?" are the same question and
answering them differently leaks. Phase 11 is the first module where they are
genuinely different questions, and it answers both:

- **403** — you are authenticated, the resource exists, and you may not do this.
- **404** — the report or target does not exist.

Phase 10's ruling D8 is untouched: staff get no wider _search_ visibility, and
`tests/moderation-security.test.ts` pins that a platform admin and an ordinary
member get identical search results.

### Rank decides who may act on whom

`moderation.access.ts` holds a total order over the six roles and one rule:

> A staff member may act on an account of **strictly lower** rank, and never on
> their own.

The consequences, each asserted in `tests/moderation-unit.test.ts` against every
role pairing:

- A moderator may action members and verified builders.
- A moderator may **not** action another moderator, a community admin, or a
  platform admin.
- A community admin may not action a platform admin.
- **No platform admin may action another platform admin.** Peers cannot depose
  peers, so removing a platform admin is a deliberate out-of-band operation
  rather than something one compromised account can do to the others.
- Nobody bans, suspends, warns, or unbans themselves.

For a content removal the rank check follows the content to its author, so a
moderator cannot delete a platform admin's post either.

Every rank refusal returns **one identical message**. Distinguishing "you
outrank nobody" from "that account outranks you" would turn the endpoint into a
probe for other users' roles.

### Nothing is taken from the client

`reporterId`, `reviewerId`, `moderatorId`, and `actorId` appear in **no schema
in this module**. Zod strips unknown keys, so a client that sends one is not
rejected — the value simply never reaches a service, and no service has a
parameter it could reach. `status`, `resolvedAt`, and the action's own id are
server-owned on the same terms.

## The report lifecycle

```
pending ──► reviewing ──► resolved
                     └──► dismissed
```

`resolved` and `dismissed` are terminal. There is deliberately **no shortcut
from `pending` straight to a closed state**: a report must be claimed before it
can be closed, which is what makes `reviewerId` mean anything.

An illegal transition is **409**, not 422 — the value is well-formed and would
be legal from another state, so it conflicts with the resource's condition
rather than with the schema. Moving a report to the state it already holds is
also a 409, so a double-submitted form is visible rather than silently
overwriting `reviewerId` and `resolvedAt`.

The transition is applied with the observed status in the `where` clause. Two
moderators claiming the same pending report race in the database and exactly one
wins; the loser gets the same 409, which is the truthful answer — by the time
their write landed, the report had moved.

### `reviewing` is retained

The shipped frontend's `ReportStatus` union has three members and omits
`reviewing`. The schema has four, and the backend keeps all four: without the
middle state there is no way for a moderator to claim a report and two
moderators would silently work the same row. The frontend filters client-side
and is unharmed by a state it never sends.

## Report targets

All six the PRD and schema carry: `user`, `post`, `comment`, `project`,
`community`, **`message`**.

The frontend's `types/admin.ts` declares five and omits `message`. `PRD.md` §17
lists "Messages" among the things users must be able to report, and
`ReportTargetType` carries the member, so the specification governs the backend
contract. The admin UI will render an empty target summary for a message report
until it learns the sixth member — a display gap, not a data one.

The target is resolved server-side before a row is written, which is how
`Report.targetAuthorId` gets filled — the schema keeps it denormalized _"so the
queue can show and action them without resolving the target's table first."_
A report against an id that does not exist is a 404.

Soft-deleted targets still resolve. A post the author deleted a second before
the report was filed is still a legitimate thing to report its author for.

## Reports bypass blocking

**This is the one place in the codebase where a `Block` does not win.**

Everywhere since Phase 4, blocking outranks membership, ownership, and admin
role. Reporting is the exception, and it has to be: the person most likely to
have blocked a harasser is the person who needs to report them. Refusing the
report would make the safety tool users reach for first fail exactly when it
matters.

Nothing else is weakened. A reporter still cannot _see_ a blocked user's
content — only report it, using an id they already hold.

## The moderation queue

Ordered **oldest first**, which is what `@@index([status, createdAt])` exists
for; the schema comments it as _"The moderation queue: pending first, oldest
first."_ A queue that surfaced the newest report first would starve the oldest.
`id` breaks the `createdAt` tie so offset paging is total-ordered.

The shipped `getReports()` sorts newest-first client-side. That is a display
choice on data it already holds and is unaffected by the server's order.

Offset pagination, per TRD §8 — a page-numbered administrative table is exactly
the case offset paging is for. The page and the count share one `where` object,
so a total can never describe a wider set than the rows.

## Moderation actions

Seven verbs, exactly the members of `ModerationActionType`. Four are named by
`ARCHITECTURE.md` §25.

| Verb              | Target       | Status after    | Expiry       | Notifies |
| ----------------- | ------------ | --------------- | ------------ | -------- |
| `warning`         | user         | unchanged       | forbidden    | yes      |
| `content_removal` | any non-user | unchanged       | forbidden    | yes      |
| `suspension`      | user         | `banned`        | **required** | yes      |
| `ban`             | user         | `banned`        | forbidden    | yes      |
| `shadow_ban`      | user         | `shadow_banned` | forbidden    | **no**   |
| `unban`           | user         | `active`        | forbidden    | no       |
| `reinstate`       | user         | `active`        | forbidden    | no       |

Account verbs take a `user` target; `content_removal` takes anything but. A
caller cannot "ban" a post or "remove" an account — the latter is guarded twice,
in the service and again in the repository's removal switch.

A suspension with no expiry is refused, because a null expiry means permanent
and that verb is already called `ban`. An expiry on any other verb is refused
for the same reason. An expiry in the past is refused.

### `unban` and `reinstate` — an implementation inference, not a requirement

**This pairing is chosen by this module. No authoritative source states it.**

Every authoritative source was searched for both verbs before this was settled.
Neither verb is defined anywhere outside the schema:

| Source                             | Names the moderation actions as                               | Distinguishes the two? |
| ---------------------------------- | ------------------------------------------------------------- | ---------------------- |
| `BACKEND_PRD.md` §17               | review reports, remove content, warn, suspend, ban            | no — names neither     |
| `BACKEND_TRD.md` §28               | warnings, content removal, suspension, banning, appeals       | no — names neither     |
| `BACKEND_ARCHITECTURE.md` §25      | warning, content removal, temporary suspension, permanent ban | no — names neither     |
| Frozen frontend (`admin/user-row`) | one **Restore** button sending `status: "active"`             | no — sends no verb     |
| `schema.prisma`                    | the seven `ModerationActionType` members                      | no — bare enum, no doc |

The specifications describe **four** actions; the schema carries **seven**.
`shadow_ban`, `unban`, and `reinstate` are all schema-only and all undocumented —
those enum members carry no `///` comment, unlike most of the schema.

The frozen frontend settles the shape but not the naming. It offers a single
**Restore** control for both `banned` and `shadow_banned` accounts and sends only
`status: "active"`, never a verb — so the server must pick one, and no source
says which.

This module pairs each verb with what it undoes: **`unban` lifts a ban or a
suspension, `reinstate` lifts a shadow ban.** That keeps both enum members
reachable and symmetric with `ban` and `shadow_ban`, and it needs no data beyond
the status change already being made.

The alternative reading — `reinstate` restores _removed content_ — is equally
defensible and would need counter restoration to be correct. It was not chosen,
and this is flagged rather than buried: **it is an implementation inference, not
a specified requirement, and it remains a candidate for a ruling.** Should that
ruling go the other way, `moderation.access.actionForStatusChange` is the single
place the pairing is decided.

## Content removal

Reuses each domain's existing `deletedAt` semantics. No schema field
distinguishes an author's deletion from a moderator's — `ModerationAction` and
`AuditLog` are where that distinction lives, which is what ruling R13 asked for.

Removal happens inside the moderation transaction and therefore reproduces each
domain's counter side-effects rather than calling its repository (none of which
accepts a transaction client):

| Target      | Side effect, mirroring                                               |
| ----------- | -------------------------------------------------------------------- |
| `post`      | none — `posts.repository.softDeletePost`                             |
| `comment`   | decrements `Post.commentsCount` — `softDeleteComment`                |
| `project`   | decrements `User.projectsCount` — `softDeleteProject`                |
| `community` | releases tags, decrementing `Tag.usageCount` — `softDeleteCommunity` |
| `message`   | none — `messages.repository.softDeleteMessage`                       |
| `user`      | **never removed this way**                                           |

`tests/moderation-repo.test.ts` asserts each counter against a real row, so the
copy cannot drift from the owner-facing path silently.

Removing already-removed content is an idempotent no-op: `contentRemoved` comes
back `false` and the action is still recorded, because a moderator confirming a
removal that already happened is a real decision.

## Audit is transactional

`TRD.md` §28: _"All important moderation actions must generate audit records."_

Every other audit write in this codebase goes through
`utils/audit.recordAuditEvent`, which catches and swallows its own failures —
the right trade for a login, where losing one record is better than failing the
login. It is the wrong trade here: an action that suspended an account but left
no record of who did it is exactly what §28 exists to prevent.

So `moderation.repository.recordModerationAction` runs **one transaction**
containing, in order:

1. the status change or content removal,
2. the `ModerationAction` row,
3. the `AuditLog` row, written with the same `tx`.

Either all three commit or none does. `insertAuditLog` grew one optional
transaction-client parameter to make this possible — the same
`client: Prisma.TransactionClient = prisma` shape `messages.repository.ts`
already used — and behaves exactly as before when it is omitted, so every
Phase 3–7 caller is unchanged.

`tests/moderation-repo.test.ts` proves the rollback directly: an action naming a
non-existent report violates the foreign key, and afterwards neither the action
nor its audit row exists.

There is exactly one code path that writes `User.status`. `PATCH
/admin/users/:id/status` delegates to it rather than having its own.

### Phase 11 verbs

`REPORT_CREATED` · `REPORT_REVIEWED` · `REPORT_RESOLVED` · `REPORT_DISMISSED` ·
`USER_WARNED` · `USER_SUSPENDED` · `USER_BANNED` · `USER_SHADOW_BANNED` ·
`USER_UNBANNED` · `USER_REINSTATED` · `USER_SUSPENSION_EXPIRED` ·
`POST_REMOVED` · `COMMENT_REMOVED` · `PROJECT_REMOVED` · `COMMUNITY_REMOVED` ·
`MESSAGE_REMOVED` · `ROLE_CHANGED`.

`ROLE_CHANGED`, `USER_BANNED`, and `POST_REMOVED` are named directly by
`ARCHITECTURE.md` §26. Removal is audited per content type rather than
generically, because §26 names the specific verb.

## Notifications

Moderation notifications go through the existing `notificationPort` — the seam
every domain service has used since Phase 4 — not a second delivery mechanism.
Two properties are specific to moderation:

- **No actor.** `actorId` is `null`, which the schema documents as the system
  case. This keeps the acting moderator out of a banned user's notification
  panel, and it is also what makes the notice immune to blocking:
  `resolveDelivery` skips the self and block checks entirely when there is no
  actor.
- **Not suppressible by preference.** `notification.access.ts` treats
  `moderation` as unsuppressible, so a user who muted the type in settings is
  still told their account was banned. A warning nobody receives is not a
  warning. `moderation` is also added to `NON_COLLAPSING_TYPES`, so two
  warnings are two notifications rather than one.

The exemption sits _after_ the self and block checks, deliberately, so it can
only ever widen delivery to the affected user — never revive a notification for
someone the recipient blocked.

The port was widened in exactly two ways: `PortNotificationType` gained
`"moderation"`, and `NotificationEvent.actorId` became `string | null`. The
schema and `notifications.service.createNotification` had always allowed a null
actor; the port was the one link in the chain that did not.

Delivery failures are logged and swallowed. The action already committed with
its audit record.

## Suspension expiry

Lazy, with **no scheduler, worker, or queue** (ruling R12).

`auth.repository.liftExpiredSuspension` is called wherever a ban is already
enforced — the auth middleware, the three login paths, and the socket handshake.
It returns early unless the account is `banned`, so only banned accounts pay for
it, and then costs one indexed query on
`moderation_actions(targetUserId, createdAt DESC)`.

The **newest** status-affecting action decides. A user who was suspended and
then banned outright stays banned: the ban is newer and carries no expiry. A
user whose newest such action is a lapsed suspension is restored to `active`,
and the restore commits with a `USER_SUSPENSION_EXPIRED` audit row whose actor
is null — there is no moderator behind it.

It lives in the auth repository rather than the moderation module because auth
is Phase 3 and moderation is Phase 11; importing the later module into the
earlier one would point the dependency arrow backwards. Reading a
`moderation_actions` row there is data-level coupling only.

## Rate limiting

`POST /moderation/reports` carries a stricter budget than the general API
surface. `ARCHITECTURE.md` §28 does not name reporting in its "Stricter limits"
list but does name _"Public APIs vulnerable to abuse"_, and a report endpoint is
one: mass filing buries a moderation queue in noise, which is a denial of
service against the moderators.

```
max(3, ceil(RATE_LIMIT_MAX × 0.1))
```

Expressed relative to the configured baseline, as Phase 10's search limiter is,
for the same three reasons: a deployment tuning `RATE_LIMIT_MAX` moves this with
it, no new environment variable is needed, and the test bootstrap that raises
`RATE_LIMIT_MAX` is inherited automatically. At the shipped baseline of 100/min
this is **10 reports a minute** — a tenth rather than search's three tenths,
because search is expensive per call and a human makes many, while reporting is
cheap per call and a human makes very few.

### Known limitation: the `rl:` prefix collision — fixed in Phase 15

**Pre-existing, from Phase 2; out of scope for Phase 11, resolved in Phase 15.**

`rate-limit.middleware.ts` gave every limiter the same Redis key prefix, `rl:`,
and `express-rate-limit` keys on the client IP. The limiter `name` reached the
log line and nothing else, so this limiter _shared a counter_ with the global
`/api` limiter, with `auth-credentials`, and with Phase 10's `search` limiter
for the same IP. The tightest budget won for all of them, and requests to
unrelated endpoints consumed this one's allowance.

Phase 15 namespaced the Redis store per limiter (`rl:<name>:`), giving each its
own counter and its own window. The report limiter's budget below is now
independent of the rest of the API.

## Known limitations

- **`unban` vs `reinstate`** is an implementation inference, above.
- **A pre-existing flaky test — fixed in Phase 15.**
  `tests/auth-unit.test.ts` → _"refuses to decrypt a tampered payload"_ failed
  roughly **1 run in 64**. It tampered with a ciphertext by overwriting the first
  base64url character with `"A"`, so whenever that character was _already_ `"A"`
  the payload was unchanged and `decryptSecret` correctly did not throw. The
  rate was measured, not estimated: **47 failures in 3000 encryptions (1.57%)**,
  matching the 1-in-64 prediction for a uniform base64url alphabet. It was Phase
  3 code and out of scope for Phase 11. Phase 15 made the substitution depend on
  the original character, so the ciphertext always changes — a test-only fix
  that leaves the production crypto untouched.
- **Shadow ban is recorded but not enforced.** Ruling R3 keeps Phase 6/7/10
  read paths untouched, so a `shadow_banned` user's posts, projects, and search
  results are still visible. The status, the action, and the audit row are all
  written; making them _mean_ something is a later decision with a large blast
  radius across four modules.
- **No appeals.** `TRD.md` §28 names an "Appeals architecture". There is no
  `Appeal` model and implementing one needs a migration, so it is deferred.
- **`targetSummary` is not served.** The shipped frontend computes it
  client-side; producing it server-side would mean joining five content tables
  per queue page and projecting a snippet of a private project or a direct
  message into the response.
- **A reporter cannot read their own report back.** Deliberate — a report
  carries the reviewer's identity, the denormalized target author, and a
  free-text resolution.
- **No forced socket disconnect on ban.** Ruling R8: a ban takes effect on the
  next HTTP request and the next socket handshake. An already-open socket
  survives until it reconnects.

## Explicitly not in this phase

Achievements · uploads · Cloudinary · AI moderation or classification · email
delivery · BullMQ or any job queue · background workers · an analytics warehouse
· appeals · Elasticsearch, Meilisearch, or OpenSearch · search ranking · Redis
caching · new socket events · frontend changes.

## Tests

| File                                | Covers                                            |
| ----------------------------------- | ------------------------------------------------- |
| `tests/moderation-unit.test.ts`     | every rule, exhaustively, with no database        |
| `tests/moderation-repo.test.ts`     | the transaction, counters, queue ordering         |
| `tests/moderation.test.ts`          | the workflow over HTTP                            |
| `tests/moderation-security.test.ts` | the attack list                                   |
| `tests/audit.test.ts`               | append-only, transactional durability, vocabulary |
