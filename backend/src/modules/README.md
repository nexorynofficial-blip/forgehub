# Feature modules

Each domain owns a self-contained module here
(BACKEND_ARCHITECTURE.md §3–4). Modules are created by the phase that
implements them, not scaffolded in advance — only `auth/` exists so far.

## Module shape

```
modules/<feature>/
  <feature>.routes.ts       HTTP endpoint definitions
  <feature>.controller.ts   Request → service call → response. No business logic.
  <feature>.service.ts      Business logic, authorization rules, orchestration
  <feature>.repository.ts   Database access via Prisma. The only layer that touches it.
  <feature>.schema.ts       Zod request validation
  <feature>.types.ts        TypeScript contracts
```

Tests live in `tests/`, **not** beside the module. BACKEND_ARCHITECTURE.md §3
sketches a co-located `<feature>.test.ts`, but `tsconfig.build.json` compiles
everything under `src/`, so a co-located test would ship inside `dist/`. §3
explicitly permits a better structure; this is one. Name them after the module
(`tests/auth.test.ts`, `tests/auth-security.test.ts`).

## Layer rules

- **Controllers stay thin** — no business logic, no Prisma calls.
- **Routes contain no logic** — they wire middleware to controllers.
- **Database access stays in repositories** — never scattered across services
  or controllers.
- **Services own authorization decisions**, not just data shuffling.

Shared functionality (logging, errors, pagination, response envelope,
middleware, Prisma/Redis clients) stays _outside_ modules, in `utils/`,
`middleware/`, `config/`, and `database/`.

## Planned modules

Per BACKEND_TRD.md §4, in the phase order defined by
BACKEND_ARCHITECTURE.md §38:

| Module          | Phase | Status                                             |
| --------------- | ----- | -------------------------------------------------- |
| `auth`          | 3     | **done**                                           |
| `users`         | 4     | **done** — absorbs `profiles`                      |
| `follows`       | 4     | **done** — absorbs blocking                        |
| `projects`      | 5     | **done** — members, roadmap, changelog, engagement |
| `posts`         | 6     | **done** — absorbs polls, engagement, and the feed |
| `comments`      | 6     | **done** — folded into `posts`                     |
| `communities`   | 7     |                                                    |
| `messages`      | 8     |                                                    |
| `notifications` | 9     |                                                    |
| `search`        | 10    |                                                    |
| `achievements`  | 10    |                                                    |
| `moderation`    | 11    |                                                    |
| `admin`         | 11    |                                                    |
| `uploads`       | 11    |                                                    |
| `ai`            | 12    |                                                    |

Two deviations from TRD §4's module list, both deliberate:

- **`profiles` folded into `users`.** `User` and `Profile` are separate tables
  but one joined view to the frontend; splitting them would put two
  repositories behind a single response.
- **`follows` moved from Phase 6 to Phase 4**, and absorbs `Block`. The
  earlier assignment was wrong: `feed-service.ts` filters the "following" feed
  through the follow graph, so the graph has to exist _before_ the feed, not
  alongside it. Blocking lives here because it is the inverse relationship and
  shares the same integrity rules.

`posts` folds `comments` in, and absorbs polls, engagement, and the feed. A
comment has no meaning outside a post and every comment write authorizes
against the post gate, so two modules would re-derive one access decision. The
feed lives here too: ARCHITECTURE §38 calls Phase 6 "Feed" while TRD §4 names
`posts`/`comments`, and the shipped UI is one component tree behind one
service. See `docs/POSTS_AND_FEED.md`.

`projects` keeps the whole aggregate — members, milestones, updates, and
engagement — in one module, but varies the file shape above: **one repository**
for the root and every child (milestone writes and the `progressPercent` they
derive must share a transaction), with **a service and controller per child**
where the business rules genuinely differ. See `docs/PROJECTS.md`.

## `communities/`

The Phase 7 aggregate. Same shape as `projects/` — one gate
(`loadVisibleCommunity`), a pure permission table, a repository that owns every
Prisma call, and a service per child area where the rules genuinely differ
(`members`, `resources`, `posts`).

One deliberate divergence from `projects/`: the community detail select loads
**only moderating members**, because a community can hold thousands. The
viewer's own membership is therefore queried separately by the gate — inferring
it from that filtered array would deny every ordinary member access to their own
private community. See `docs/COMMUNITIES.md`.

## Cross-module dependencies

Modules may depend on those above them, never below:

```
auth     ──►  (nothing)
users    ──►  follows     (profile visibility consults the social graph)
follows  ──►  users       (targets are resolved by username; previews reuse
                           the shared user projection)
projects ──►  users       (owners/members/authors reuse `toUserSummary`)
projects ──►  follows     (a blocked viewer cannot see the blocker's projects)
posts    ──►  users       (authors reuse `toUserSummary`)
posts    ──►  follows     (blocking, and the "following" feed filter)
posts    ──►  (Community)  Phase 7 reads `Community` **through its own
                           repository**, not the communities service — see below
communities ► users      (owners/members reuse `toUserSummary`)
communities ► follows    (a blocked viewer cannot see the blocker's community)
communities ► posts      (community posts reuse the Phase 6 create, projection,
                           counters, and validation wholesale)
```

`projects` and `posts` each depend on `users` and `follows`; neither depends on
the other. `communities` depends on all three.

### The posts ↔ communities seam (Phase 7)

The dependency between these two runs **one way at the service layer**:
`communities/posts.service.ts` calls into `posts.service`, never the reverse.

But post visibility genuinely needs the community — a post in a private
community must 404 for a non-member. Rather than have the older, closed posts
module import a sibling _service_ (which itself reads posts, for pinning, and
would close a cycle), `posts.repository.ts` gained two narrow reads of the
`Community` and `CommunityMember` tables. The rule they feed lives in
`post.visibility.ts` as a `CommunityStanding`, resolved by the caller.

See `docs/COMMUNITIES.md` §10 for what changed and why.

`users` and `follows` reference each other's **repositories and pure helpers**,
not each other's services, which keeps the cycle out of the business layer.
The shared projection in `users/user.view.ts` is the single place a Prisma row
becomes an API shape — later modules that need to render a user (posts,
comments, messages) should reuse `toUserSummary` rather than inventing their
own.

Each module's router mounts onto the v1 router in `src/routes/index.ts`.
