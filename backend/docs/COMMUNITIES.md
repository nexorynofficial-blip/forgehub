# Communities (Phase 7)

Communities, membership and roles, community-owned resources (rules, tags,
events, pinned posts), and the community posts that finally activate the seam
Phase 6 left open.

Everything below describes what the code does. Where a rule exists because the
schema is frozen and could not accommodate the alternative, that is said
plainly rather than dressed up as a design choice.

---

## 1. The shape of the module

```
src/modules/communities/
  communities.types.ts        contracts — mirrors the frontend's `Community`
  community.visibility.ts     pure visibility + join rules
  community.access.ts         pure role/permission table
  communities.schema.ts       request validation
  community.view.ts           the projection chokepoint
  communities.repository.ts   the only file that touches Prisma
  communities.service.ts      the gate, discovery, CRUD
  members.service.ts          membership, roles, ownership
  resources.service.ts        rules, tags, events, pins
  posts.service.ts            community posts
  *.controller.ts             HTTP adapters, no logic
  communities.routes.ts       route table
```

The discipline is the one Phases 4–6 established: pure rules are unit-tested
without a database, the repository owns every Prisma call, the view layer is
the single place a row becomes a response, and **`loadVisibleCommunity` is the
one gate every community-scoped operation passes through.**

That last point is load-bearing. A child route that loaded the community itself
would be one refactor away from forgetting the block check, and a blocked viewer
reaching a member roster or rule list through a side door defeats the rule
entirely.

---

## 2. Visibility

Resolved twice — once as a pure function (`resolveCommunityVisibility`,
`isCommunityListable`) and once as SQL (`listVisibilityWhere`). The two must
agree branch for branch. If they diverge, paging silently returns short pages,
which is the failure Phases 5 and 6 each hit once.

|                              | Direct read by slug             | Appears in discovery      |
| ---------------------------- | ------------------------------- | ------------------------- |
| **public**                   | everyone                        | everyone                  |
| **unlisted**                 | everyone                        | **no** — never enumerated |
| **private**                  | owner, members, platform admins | only those same people    |
| **soft-deleted**             | nobody, including the owner     | no                        |
| **owner blocked the viewer** | nobody                          | no                        |

Rule order inside the gate is deliberate:

1. **Soft delete first.** A deleted community is not a privacy question.
2. **Blocking outranks everything** — membership, ownership, and the platform
   admin role. Admin moderation tooling is a Phase 11 surface with its own
   audited endpoints; it must not arrive by accident through a community read.
3. Owner, then member, then admin — cheapest identity checks first.
4. `unlisted` resolves to readable and is filtered out of listings instead.
   That split is the entire distinction PRD §6 draws: unlisted means "not
   enumerable", not "not readable". It is also what makes self-join-by-slug
   coherent.

**Hidden communities always answer 404, never 403.** A 403 confirms the
community exists and, in the block case, announces the block.

---

## 3. Membership

### Roles

Four, from `CommunityRole`: `owner`, `admin`, `moderator`, `member`.

| Action                 | owner | admin | moderator | member | non-member |
| ---------------------- | :---: | :---: | :-------: | :----: | :--------: |
| edit community         |   ✓   |   ✓   |           |        |            |
| delete community       |   ✓   |       |           |        |            |
| transfer ownership     |   ✓   |       |           |        |            |
| manage members         |   ✓   |   ✓   |           |        |            |
| assign `admin` role    |   ✓   |       |           |        |            |
| manage rules           |   ✓   |   ✓   |           |        |            |
| manage events          |   ✓   |   ✓   |     ✓     |        |            |
| pin posts              |   ✓   |   ✓   |     ✓     |        |            |
| remove community posts |   ✓   |   ✓   |     ✓     |        |            |
| create community posts |   ✓   |   ✓   |     ✓     |   ✓    |            |

Platform admins (`moderator`, `community_admin`, `platform_admin`) bypass the
membership table for everything **except two cases**:

- **`transfer_ownership` and `assign_admin_role`** are reserved to the owner of
  record. Reassigning someone's community is a moderation act; moderation is
  Phase 11's, with its own audit requirements. Role escalation also has to
  terminate somewhere, and the owner is where it terminates — otherwise an
  admin holding `manage_members` could mint a second admin, or promote
  themselves toward the owner's authority.
- **`create_post`** is not reachable by the admin bypass at all. Posting is
  participation, not moderation: a platform admin who wants to post joins the
  community like everyone else. Letting the bypass grant it would give the
  "non-members cannot post" rule an exception no part of the UI communicates.

Two grants deserve their reasoning stated. A **`member` may only create posts** —
that is the one thing membership buys; everything above it is running the place.
A **`moderator` gets events but not rules**: events are operational and someone
has to be able to correct them, while rules are the community's constitution and
rewriting one is an admin act. That split mirrors how the shipped page presents
the two — events are a dated feed, rules a numbered charter.

### Rank comparisons

`manage_members` is a single grant but not a single question. A manager may act
only on someone **strictly below** their own rank (`owner` 3 > `admin` 2 >
`moderator` 1 > `member` 0). That is what stops two admins removing each other
and what stops an admin touching the owner.

Role changes check **both ends**: the caller must outrank the member's _current_
role and be permitted to grant the _new_ one. Checking only the first would let
an admin promote a member straight past themselves.

### Join and leave

| Visibility | Self-join                                               |
| ---------- | ------------------------------------------------------- |
| public     | immediate                                               |
| unlisted   | immediate — reaching it means someone gave you the slug |
| private    | refused; an owner or admin adds you                     |

**There are no invitations and no pending requests.** `NotificationType` already
contains `community_invite`, but no `CommunityInvite` model exists and the schema
is frozen, so there is nowhere to persist a pending state. A private community is
joined by being added. This is a schema limitation, not a product decision.

A duplicate join is **409**, not a silent success: a client that receives 201 for
a join that created nothing cannot tell whether it just joined or was already in.

Leaving is refused for the owner (**422**), with a field-level message pointing
at the transfer endpoint. Removing a member who is not there is **404** — the
caller named a specific row to delete and it does not exist.

---

## 4. Ownership

`Community.ownerId` is authoritative. The `owner` `CommunityMember` row is
created in the same transaction as the community itself, so the two can never
disagree from the first instant.

The `owner` **membership role** is deliberately _not_ enough to transfer
ownership. `ROLE_PERMISSIONS.owner` omits `transfer_ownership` and
`assign_admin_role` precisely so the table cannot claim otherwise: a membership
row that has drifted from `ownerId` must not confer the authority to rewrite
`ownerId`.

Transfer is one transaction performing four writes:

1. `Community.ownerId` moves to the successor.
2. The successor's membership becomes `owner` — created if they were not
   already a member.
3. `memberCount` increments **only** in that create case.
4. The previous owner is demoted to `admin`, not removed. A founder who hands
   over should not lose access to what they built.

The invariant _"`ownerId` always has a `CommunityMember` row"_ therefore holds at
every commit point.

---

## 5. `memberCount`

Denormalized on `Community`, and never updated by read-modify-write. Every move
is Prisma's `{ increment: 1 }` / `{ decrement: 1 }`, which compiles to
`SET x = x ± 1` under the row lock.

**`@@unique([communityId, userId])` is the arbiter.** A duplicate insert raises
`P2002`, the transaction rolls back, and the increment rolls back with it — which
is what makes the counter correct under concurrency without any explicit lock.
Verified with real simultaneous requests: six distinct joins all count; eight
identical joins commit exactly one and roll back the other seven.

Decrements are **double-guarded** — the delete must have actually removed a row
(`deleteMany`'s count), _and_ `memberCount` must be `> 0`. Two guards because
they fail differently: the first stops a no-op delete from decrementing, the
second stops an already-drifted counter from going negative.

---

## 6. `Tag.usageCount` is shared

One counter, **two writers**: `ProjectTag` from Phase 5 and `CommunityTag` from
here. It therefore counts total usages across both, which is what the
`usageCount DESC` index exists for.

Consequences the code has to respect:

- The decrement is guarded by `usageCount: { gt: 0 }` **in the same statement**.
  This is not defensive noise. `prisma/seed.ts` creates both `ProjectTag` and
  `CommunityTag` rows without ever touching `usageCount`, so seeded tags sit at
  **0 while genuinely in use**. An unguarded decrement would drive them negative
  the first time a seeded community's tags were edited.
- A replace-set computes the **delta** against what is already attached, so
  re-submitting an identical set is a no-op rather than another increment.
- References are de-duplicated before the delta, so a display name and its slug
  in one request cannot increment twice for one link row.
- Deleting a community **releases its tags**, or the counter stays permanently
  inflated — the exact drift a Phase 5 test-cleanup bug produced, fixed here by
  construction.

Only existing `Tag` rows may be attached. An unknown reference is **422**, never
an implicit create: a client that asked for three tags and got two back has been
lied to, and letting any authenticated user mint taxonomy rows would make the
shared table unbounded. Phase 10 owns search and free-text tagging.

---

## 7. Rules

Replace-set. The submitted array _is_ the rule list, and its index becomes
`CommunityRule.position`. Delete-and-insert inside one transaction, so a reader
never sees a half-replaced charter.

Per-rule CRUD was rejected because the frontend contract is a flat `string[]`: a
client holding only strings has no id with which to address a single rule, and
reordering through individual patches would need a position-shuffling protocol
for no gain. An empty array is valid and clears them.

Requires `manage_rules` — owner or admin.

---

## 8. Events, and the `attendeeCount` that cannot move

`CommunityEvent` carries `attendeeCount`, and **there is no RSVP or attendance
table anywhere in the schema**, which is frozen. No write path can ever move
that column.

So it is **never projected and never accepted**. The public `CommunityEventView`
omits it entirely rather than reporting a permanent `0`, because a zero reads as
"nobody is attending" instead of "attendance does not exist here". The write
schemas have no such field, so a client that sends one has it stripped and the
stored value stays at its default.

This is a documented limitation. Implementing RSVPs needs a schema change and
belongs to whichever phase owns it.

Event CRUD requires `manage_events` — moderator and above. Start/end ordering is
enforced in the schema for a full request, **and again in the service** for a
patch that moves only `startsAt`, because that case has to be validated against
the stored `endsAt` — information the schema does not have.

---

## 9. Pinned posts

Three independent checks on a pin, none implied by the others:

1. **`pin_posts`** — moderator and above.
2. **The post belongs to _this_ community.** Without it, a moderator of one
   community could pin a post out of another — including out of a private
   community they have no standing in, which would then be listed by id on a
   page anyone can read.
3. **The post is not soft-deleted**, so a deleted post cannot be resurrected
   into a pinned slot.

A wrong-community, missing, or deleted post is **404**, not 422: from this
community's perspective it does not exist, and saying "wrong community" would
confirm a post the caller may have no right to know about.

The composite primary key `[communityId, postId]` is the duplicate arbiter — a
second pin is 409. Because that key is composite, this table can never use the
`cursor: { id }` helper; there is no surrogate id to cursor on.

A pin is only a reference, so the listing re-reads the posts and drops any that
have since been deleted.

---

## 10. Community posts — the Phase 6 seam

This is the part of Phase 7 that reaches back into a closed phase, so it is
documented in detail.

### What Phase 6 left

Decision J9 made every post carrying a `communityId` **author-only and absent
from every listing**, because no `Community` existed to evaluate and guessing
"public" would have leaked private-community content the moment Phase 7 landed.
That placeholder lived in two places:

- `post.visibility.ts` — an `inCommunity: boolean`, where any `true` meant
  "author only"
- `posts.repository.ts` — `communityId: null` welded into `listVisibilityWhere`

### What Phase 7 replaced it with

`inCommunity: boolean` became `community: CommunityStanding | null`:

| Standing   | Meaning                                                         |
| ---------- | --------------------------------------------------------------- |
| `null`     | not a community post — takes exactly the Phase 6 path           |
| `readable` | the viewer may read it; the post's own visibility still applies |
| `hidden`   | private community they are not in, or a deleted community → 404 |
| `listable` | additionally public, so it may appear in the global feed        |

Two ordering rules matter:

- **The community gate runs _before_ the post's own visibility.** A `public`
  post inside a `private` community is private. Reversing the order would expose
  the entire contents of every private community, since posts default to public.
- **`hidden` is checked before the author check.** A soft-deleted community
  takes its posts with it for _everyone_, authors included. They are not
  converted back into ordinary global posts.

### Creation

`POST /communities/:slug/posts` is the **only** way a post acquires a
`communityId`, and the value comes from the resolved community, never from the
body — `createPostSchema` has no such field, so a client naming one has it
stripped by Zod before the handler runs. Everything else about the post is Phase
6's, unchanged: the same validation, counters, mention announcement, and
projection.

`create_post` is a membership grant, so a non-member is refused **even in a
public community**, and so is a platform admin who has not joined.

### Listing

The global feed admits community posts only from **public, live** communities.
Membership is deliberately not consulted there: a member reads their private
community's posts on the community page, which owns its own scoped listing.
Widening the feed filter to "public OR I am a member" would mix
private-community content into `following`, `trending`, `recommended`, and
`popular_today`.

The community's own listing is broader — it serves whatever the community's
gate already approved — but still excludes soft-deleted posts and blocked
authors.

---

## 11. Audit

Added this phase: `COMMUNITY_CREATED`, `COMMUNITY_DELETED`,
`COMMUNITY_MEMBER_ADDED`, `COMMUNITY_MEMBER_REMOVED`, `COMMUNITY_ROLE_CHANGED`
(named directly by BACKEND_ARCHITECTURE.md §26), and
`COMMUNITY_OWNERSHIP_TRANSFERRED`.

**Joining and leaving are deliberately not audited.** Like follows, they are
high-volume ordinary activity, and a self-join confers no authority over anyone
else.

---

## 12. Deliberately not built

| Deferred                                        | Why                                                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Invitations / pending join requests**         | No `CommunityInvite` model; schema frozen. `NotificationType.community_invite` exists but has nothing to reference. |
| **RSVPs / attendance**                          | No table. `CommunityEvent.attendeeCount` therefore has no writer and stays at 0.                                    |
| **WebSocket rooms** (`community:{communityId}`) | ARCHITECTURE §14 reserves the room name; realtime delivery belongs to its own phase.                                |
| **Notification delivery / fan-out**             | The port is called; Phase 9 owns persistence and delivery.                                                          |
| **Moderation / reporting**                      | `Report` and `ModerationAction` exist in the schema; Phase 11 owns the surface and its audit requirements.          |
| **Search**                                      | `q` here is a `contains` filter, not an index. Phase 10 owns search.                                                |
| **Uploads**                                     | `avatarUrl` and `bannerUrl` are bounded strings, matching the Phase 5 precedent. Phase 11 owns uploads.             |

---

## 13. Known pre-existing issue

Not introduced by Phase 7 and not fixed here, but worth recording where someone
will find it: **the global rate limiter and the credential limiter share one
Redis key.** Both use `express-rate-limit`'s default IP key under the `rl:`
prefix, so ordinary API traffic consumes the strict auth budget — 25 anonymous
requests can cause the next login to 429. It is invisible to the test suite
because `isTest` swaps in the in-memory store, giving each limiter its own
counter. It only manifests with Redis.
