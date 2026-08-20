# Users, profiles, and the social graph

Decisions behind `src/modules/users/` and `src/modules/follows/` (Backend
Phase 4). Read alongside BACKEND_PRD.md §3, §5, §10 and
BACKEND_ARCHITECTURE.md §8, §10, §18.

## Module boundaries

TRD §4 lists `users`, `profiles`, and `follows` as three modules. Phase 4
ships **two**, and the reasoning is worth recording because later phases will
face the same question:

- **`profiles` is folded into `users`.** The two tables exist so a public
  profile read never touches `passwordHash` (Phase 2), but the frontend
  consumes one joined `User` object. Two modules behind one response would
  mean two repositories, two services, and a join that belongs to neither.
- **`follows` absorbs `Block`.** A block is the inverse of a follow and shares
  its integrity rules — the same transaction that creates one destroys the
  other.

`follows` also moved from Phase 6 to Phase 4. `feed-service.ts` filters the
"following" feed through the follow graph, so the graph must exist first.

## The projection layer

**Nothing outside `users/user.view.ts` turns a Prisma row into an API
response.** That single chokepoint is what makes "can this endpoint leak
`passwordHash`?" a question with one place to look.

Four projections, each mirroring a shipped frontend type:

| Projection           | Frontend type                          | Used by                              |
| -------------------- | -------------------------------------- | ------------------------------------ |
| `toUserView`         | `User` (`types/user.ts`)               | Public profile                       |
| `toCurrentUserView`  | `User` + owner-only fields             | `/users/me`                          |
| `toRedactedUserView` | —                                      | Followers-only profile, non-follower |
| `toUserSummary`      | `PostAuthor` (`types/feed.ts`)         | Reserved for posts/messages/admin    |
| `toUserPreview`      | `FollowerPreview` (`types/profile.ts`) | Follower/following/block lists       |

`toUserView` takes `includeEmail` as a **required** parameter rather than an
option with a default. Forgetting to decide is then a compile error rather
than a silent disclosure.

`toRedactedUserView` is built by _construction_, never by deleting keys from a
full view. An omission list would start leaking the day someone adds a field
to `UserView`; adding a field to the redacted shape has to be deliberate.

The repository's selects never include `passwordHash` at all — that column is
reachable only from `auth.repository.ts`. The projection layer is defence in
depth on top of that.

## Privacy rules

Two independent rules that compose. A viewer can be allowed the full profile
and still not be shown the email.

### Visibility (`visibility.ts`)

Pure functions, tested without a database. Evaluated in this order:

| #   | Condition                                              | Result      |
| --- | ------------------------------------------------------ | ----------- |
| 1   | Target has blocked the viewer                          | `not_found` |
| 2   | Viewer is the target                                   | `full`      |
| 3   | Viewer is moderator / community admin / platform admin | `full`      |
| 4   | Profile is `public`                                    | `full`      |
| 5   | Viewer follows the target                              | `full`      |
| 6   | otherwise                                              | `redacted`  |

**Blocking outranks everything, including the admin role.** A 403 would
confirm the account exists and announce the block; 404 is indistinguishable
from a deleted or never-existing account, which is the entire point. Admin
moderation tooling is a Phase 11 surface with its own audited endpoints — it
should not arrive by accident through a profile read.

`guest` is never treated as an admin. It is the frontend's sentinel for "not
signed in" and is never persisted.

### Email exposure (`canSeeEmail`)

Visible to the owner, to admins (moderation, and the Phase 11 admin tables),
or when the owner set `showEmailOnProfile`. Otherwise `email` is `null` — not
absent, so the response still satisfies the frontend's `User` shape.

### The redacted shape

Identity only: `id`, `username`, `displayName`, `avatarUrl`, `bannerUrl`,
`role`, `builderRank`, the three counters, `createdAt`, and `restricted: true`.

Deliberately excluded: email, bio, skills, tech stack, social links,
experience, achievements, badges, and reputation detail. Counters and
`builderRank` stay because they are aggregate labels the profile header
renders as a shell, not content the owner authored.

**The follower and following lists apply the same gate.** Without it a
followers-only profile would still hand out its entire social graph to anyone
who asked, which is a complete bypass of the setting the user chose.

## Blocking semantics

`POST /users/:username/block` runs as **one transaction**:

1. delete blocker → blocked follow (if any), decrementing both counters
2. delete blocked → blocker follow (if any), decrementing both counters
3. insert the `Block` row

Removing only the blocker's own follow would leave the blocked user still
following — and therefore still receiving the blocker's posts through the
following feed, which is exactly what a block is meant to stop.

Consequences:

- A block in **either** direction forbids a follow in **either** direction,
  and the refusal is a `404`, not a `403` — confirming that a block
  specifically is in the way would disclose it.
- **Unblocking does not restore the follows.** Silently resurrecting a
  relationship the blocker deliberately severed would be a surprising side
  effect; re-following is a decision to make again.
- Blocking an already-blocked user is a `409`, so a client can tell "done"
  from "already done". Unblocking is idempotent.
- `RelationshipView` exposes `isBlocking` but **never `isBlockedBy`**. The
  blocked party's profile read already resolves to 404; a field announcing the
  block would be a disclosure on top of that.
- Blocks are audited (`USER_BLOCKED` / `USER_UNBLOCKED`). Follows are not —
  they are high-volume ordinary activity, not security events.

## Follow counter semantics

`followersCount` and `followingCount` are denormalized (Phase 2), so every
relationship write moves them **inside the same transaction** as the row
change. There is no reconciliation job; correctness is maintained at write
time.

What makes this safe under concurrency:

- **`@@unique([followerId, followingId])` is the arbiter.** Eight simultaneous
  identical follows all attempt the insert; exactly one commits and the other
  seven raise `P2002` and roll back — including their counter increments.
- **`{ increment: 1 }` compiles to `SET x = x + 1`** under a row lock, so two
  _different_ followers of the same target serialize rather than losing an
  update to a read-modify-write race.
- **Decrements are gated on a row actually being deleted.** `deleteMany`
  returns a count, and the counters only move when it is non-zero — which is
  what lets unfollow be idempotent without driving counters negative.

All three properties are covered by integration tests that fire real
concurrent requests, not mocks.

## The NotificationPort boundary

PRD §14 requires a follow to notify, but the notifications module is Phase 9.
Phase 4 declares the seam in `src/ports/notification.port.ts` and backs it
with a no-op.

Writing `Notification` rows directly from the follows service would put
notification concerns inside the social graph and leave Phase 9 with a second
write path to find. The port costs one small file and keeps the dependency
pointing the right way: domain services depend on the interface, never on the
notifications module.

Phase 9 replaces `noopNotificationPort` with a real implementation that
persists the row and emits the Socket.IO event. No consumer changes.

## Username handling

Rules mirror the shipped account form (`src/lib/validations/settings.ts`)
exactly: 3–30 characters, `/^[a-z0-9._]+$/i`. Server-side additions:

- **Lowercased on write.** Postgres comparison is case-sensitive, so without
  this "Ava" and "ava" would be two accounts at two profile URLs.
- **Reserved handles rejected** — `me`, `admin`, `api`, `settings`, and
  similar. `/users/me` and `/users/:username` share a prefix, and profile URLs
  are `/profile/[username]`.
- **Must contain at least one alphanumeric.** `...` is in-charset but unusable
  as an identifier and looks like a broken URL.

The unique index is the real guarantee. A pre-check produces a clean `409` for
the common case, and a `P2002` catch covers the race where someone claims the
name between check and write — without it, that race would surface as a 500.
Changes are audited (`USERNAME_CHANGED`).

## Email changes are refused, not ignored

The shipped Settings form posts `email` alongside the profile fields.
Changing an email address is a credential operation requiring re-verification,
which Phase 4 does not implement.

An unchanged value passes. An actual change returns `422` with a field-level
message. Silently discarding a field the client believes it saved would be
worse than an explicit refusal.

## What Phase 4 deliberately does not do

- **Achievements and badges are read-only.** The awarding engine is Phase 10.
- **Reputation is read-only.** `xp`, `builderRank`, `dailyStreak`, and the
  score fields are served but no endpoint mutates them; unknown keys are
  stripped by the Zod schema, so a patch cannot become a back door into XP.
- **No avatar or banner upload.** The "Change avatar" button needs Cloudinary
  (Phase 11); the API accepts a URL only.
- **`whoCanMessage` is stored but not enforced** — enforcement belongs with
  messaging in Phase 8.
- **No admin user management.** An admin can _read_ a private profile; editing
  someone else's record is a Phase 11 surface with its own audit requirements.
- **No user search or discovery** (Phase 10).
- **`projectsCount` is served but never written** — Phase 5 owns it.
