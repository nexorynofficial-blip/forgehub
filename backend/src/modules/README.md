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
| `communities`   | 7     | **done** — roles, rules, tags, events, pins        |
| `messages`      | 8     | **done** — conversations, receipts, reactions      |
| `notifications` | 9     | **done** — suppression, delivery, read state       |
| `search`        | 10    | **done** — five entities, one endpoint, no ranking |
| `achievements`  | —     | unassigned by §38                                  |
| `moderation`    | 11    | **done** — reports, actions, transactional audit   |
| `admin`         | 11    | **done** — users, analytics, audit-log access      |
| `uploads`       | —     | unassigned by §38                                  |
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

## `messages/`

The Phase 8 aggregate, and the first one whose surface is split across two
transports. Same shape as `communities/` — one gate
(`loadAccessibleConversation`), a pure rule module (`message.access.ts`), a
repository that owns every Prisma call, one projection layer.

Two divergences worth knowing:

- **The Zod schemas are shared with the socket layer.** A socket frame is
  exactly as untrusted as an HTTP body and skips the middleware stack entirely,
  so `messages.schema.ts` validates both. A bound tightened for REST cannot be
  left loose on the socket path.
- **`src/sockets/message.socket.ts` and `presence.socket.ts` live outside this
  directory** but call straight into this service. They hold no rules of their
  own: there is no socket-only path into the data, so there is no second place
  for an authorization check to be missing. See `docs/MESSAGING.md`.

## `notifications/`

The Phase 9 aggregate, and the only one that is written to almost entirely by
_other_ modules. Same shape as its predecessors — pure rules
(`notification.access.ts`), a repository that owns every Prisma call, one
projection layer — with two things worth knowing:

- **Nothing imports it directly except the port.** `TRD` §22 requires the
  notification service to stay independent of the services that trigger it, so
  domain code depends on `ports/notification.port.ts` and never on this
  module. The one exception is `projects/updates.service.ts`, which calls the
  fan-out helper because the port is single-recipient by design.
- **There is no create endpoint.** Notifications are produced by domain events;
  the REST surface is read and mark-read only. See `docs/NOTIFICATIONS.md`.

## `search/`

The Phase 10 module, and the only one that reads across every other aggregate.
Same shape as its predecessors — pure rules (`search.access.ts`), a repository
that owns every Prisma call, one projection layer — with three things worth
knowing:

- **It is read-only and depends on nothing but data.** One route, `GET
/search`, no writes, no socket surface. Domain modules do not know it exists,
  so the dependency arrow runs one way and there is no seam to invert.
- **Visibility is applied in SQL, and admins get no widening.** The clauses
  reuse `posts` and `communities` `listVisibilityWhere` where those are
  exported, and re-express the project and user clauses where they are not.
  Every reuse passes a null role, which is what structurally disables the
  admin branches: search is discovery, not moderation.
- **`search.access.ts` mirrors the SQL as pure predicates**, the same way
  `project.visibility.ts` mirrors its repository. The repository tests pin the
  two together on real rows so they cannot drift. See `docs/SEARCH.md`.

## `moderation/` and `admin/`

The Phase 11 pair. Two modules rather than one because `ARCHITECTURE.md` §29
names two API roots, and keeping them apart is what lets role changes and audit
reads be gated more tightly than the moderation queue. Four things worth
knowing:

- **This is where `requireAdmin` and `requirePlatformAdmin` come alive.** Both
  were written in Phase 3 and mounted on no route until now; `auth-security`
  exercised them against a throwaway router.
- **Phase 11 is the first module with a 403.** `ARCHITECTURE.md` §18 requires
  one for an authorization failure. Phases 5–10 answered visibility refusals
  with 404 because there "may you see this?" and "does this exist?" are the
  same question; here they are genuinely different and both are answered.
- **Mutation and audit commit together.** `recordModerationAction` runs one
  transaction over the status change, the `ModerationAction`, and the
  `AuditLog`. There is exactly one code path that writes `User.status`, and
  `/admin/users/:id/status` delegates to it rather than having a second.
- **Rank, not a boolean, decides who may act on whom.** Everywhere else asks
  `isAdminRole(role)`; moderation is the first surface where one privileged
  user acts on another, so `moderation.access.ts` adds a total order over the
  six roles. See `docs/MODERATION.md` and `docs/ADMIN.md`.

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
messages ──►  users       (senders and participants reuse `toUserSummary`;
                           `whoCanMessage` is read through the users repository)
messages ──►  follows     (blocking outranks membership; the `followers` contact
                           policy consults the follow graph)
notifications ► users     (actors are projected to a four-field summary)
notifications ► follows   (blocking suppresses a notification in either
                           direction)
search   ──►  posts       (reuses the exported `listVisibilityWhere`)
search   ──►  communities (reuses the exported `listVisibilityWhere`)
                          (projects' equivalent is module-private, so that one
                           clause is re-expressed and pinned by tests)
moderation ─►  posts, projects, communities, messages
                          (soft-deletes their rows inside its own audit
                           transaction, reproducing each domain's counter
                           side-effects — none of their repositories accepts a
                           transaction client)
admin    ──►  moderation  (access rules, the transactional write, report counts)
admin    ──►  repositories/audit
(everything) ► ports/notification.port.ts
                          (follows, posts, projects, communities, and messages
                           raise events through the port — never by importing
                           the notifications module)
```

`projects` and `posts` each depend on `users` and `follows`; neither depends on
the other. `communities` depends on all three. `messages` depends only on
`users` and `follows` — it has no relationship to projects, posts, or
communities, and nothing depends on `messages`. `notifications` likewise
depends only on `users` and `follows`; every other module reaches it through
the port, which is what keeps the arrow pointing one way.

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
