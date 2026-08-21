# Projects

Decisions behind `src/modules/projects/` (Backend Phase 5). Read alongside
BACKEND_PRD.md §6–7, BACKEND_TRD.md §5, and BACKEND_ARCHITECTURE.md §9, §18.

## Module boundaries

One module for the whole project aggregate — `Project` plus `ProjectMember`,
`ProjectMilestone`, `ProjectUpdate`, `ProjectLike`, and `ProjectFollower`.

Phase 4 split `users` and `follows` because the follow graph is a genuinely
separate relation with its own integrity rules. Projects are not that shape:
every child here is _scoped by `projectId`_, every write authorizes against the
same project row, and every read passes the same visibility gate. Splitting
them would mean four modules re-deriving one access decision.

The internal layout differs slightly from the per-feature triad in
`modules/README.md`, and deliberately:

- **One repository** (`projects.repository.ts`) for the aggregate root and all
  its children. A repository per child would put `ProjectMilestone` writes and
  the `progressPercent` they derive into two different files, when they must
  share a transaction.
- **A service and controller per child** (`members`, `milestones`, `updates`,
  `engagement`), because those are genuinely different business rules.

## The single gate

`projects.service.loadVisibleProject(slug, viewer)` is the **only** entry point
to a project. Every read, every write, every child route, and every engagement
action goes through it.

That is what makes the privacy rules hold everywhere without being restated.
A child route that loaded the project itself would be one refactor away from
forgetting the block check, and a blocked viewer reaching a project's milestone
list through a side door would defeat the rule entirely.

It returns the project row, the viewer's ownership and membership facts, and
the `ProjectAccessContext` every subsequent authorization check consumes.

## Visibility

`project.visibility.ts` — pure functions, tested without a database.

**Not** a reuse of `users/visibility.ts`. That resolves `ProfileVisibility`
(`public` | `followers`); this resolves `Visibility` (`public` | `private` |
`unlisted`). Different enums, different rules — a shared function would have to
branch on which kind of subject it was given, which is how privacy logic drifts.

| #   | Condition                                        | Direct read | In listings |
| --- | ------------------------------------------------ | ----------- | ----------- |
| 1   | Soft-deleted                                     | `not_found` | omitted     |
| 2   | Owner has blocked the viewer                     | `not_found` | omitted     |
| 3   | Viewer is the owner                              | `full`      | included    |
| 4   | Viewer is a member                               | `full`      | included    |
| 5   | Viewer is moderator / community / platform admin | `full`      | included    |
| 6   | `public`                                         | `full`      | included    |
| 7   | `unlisted`                                       | `full`      | **omitted** |
| 8   | `private`                                        | `not_found` | omitted     |

**Rule 7 is the whole point of `unlisted`.** PRD §6 lists `private` and
`unlisted` as distinct states, and the only coherent difference is
enumerability: unlisted means "not listed", not "not readable". A link works;
discovery does not surface it.

**Every closed gate is a 404, never a 403.** A 403 confirms the project exists,
and for a blocked viewer it announces the block.

**Blocking outranks the admin role**, carrying forward the Phase 4 precedent.
Admin moderation tooling is a Phase 11 surface with its own audited endpoints;
it should not arrive by accident through a project read.

The listing filter is expressed twice on purpose — once as the pure
`isProjectListable`, once as SQL in `listVisibilityWhere`. The pure function is
what the unit tests pin the rules to; the SQL is what stops a hidden project
consuming a page slot or inflating `total`. They must agree branch for branch.

## Permissions

`project.access.ts` — a static table, so every (action × role) pair is
enumerable in a unit test rather than discovered in production.

| Action               | owner | admin | developer / designer / collaborator | contributor | platform admin |
| -------------------- | ----- | ----- | ----------------------------------- | ----------- | -------------- |
| `edit_project`       | ✓     | ✓     |                                     |             | ✓              |
| `delete_project`     | ✓     |       |                                     |             | ✓              |
| `manage_members`     | ✓     | ✓     |                                     |             | ✓              |
| `manage_milestones`  | ✓     | ✓     | ✓                                   |             | ✓              |
| `create_update`      | ✓     | ✓     | ✓                                   | ✓           | ✓              |
| `moderate_updates`   | ✓     | ✓     |                                     |             | ✓              |
| `transfer_ownership` | ✓     |       |                                     |             |                |
| `assign_owner_role`  | ✓     |       |                                     |             |                |

Two things this encodes:

- **Ownership actions are owner-only** — not a member holding the `admin`
  role, and not a platform admin. Reassigning someone's project is a moderation
  action, and moderation is Phase 11 with its own audit requirements.
- **Authorship is checked separately.** `canModifyUpdate` lets a contributor
  edit their own update even though they hold no `moderate_updates` grant. That
  cannot be a row in the table, because it depends on the row being edited.

`ProjectMember.permissions` (a `String[]`) is deliberately **unused**. It is a
forward-looking ACL hook; populating it with grants nothing enforces would
create a field that looks authoritative and is not.

## Ownership has one authority

`Project.ownerId` is authoritative. The `owner` membership row exists alongside
it because the seed creates one and later phases read the membership table for
access checks — but the column is the truth.

They must never disagree, so every write that could separate them is refused:

- **Create** inserts the project and the owner's membership in one transaction.
- **`POST /members` and `PATCH /members/:username` refuse `role: "owner"`** with
  a 422 naming the transfer endpoint. Accepting it would create a second owner
  membership on a project whose `ownerId` still named someone else.
- **The owner's role cannot be changed**, and **the owner cannot leave**.
- **Transfer** moves `ownerId`, upserts the recipient's membership to `owner`,
  demotes the previous owner to `collaborator`, and moves both users'
  `projectsCount` — in one transaction.

The previous owner is demoted rather than removed: dropping them would erase
their contribution history from the team list.

## `progressPercent` is derived, not stored input

The schema comment says "Denormalized from milestone completion", and that is
now literally true. It is recomputed inside the same transaction as every
milestone create, update, and delete, and it is **absent from every write
schema** — a client cannot assert a figure its own roadmap contradicts.

Zero milestones is **0%**. An empty roadmap is the start of a project, not a
finished one.

It is derived **on write, not on read** — the column stays denormalized, which
is the whole reason it exists (DATABASE.md justifies these counters so a list
view does not run a correlated subquery per row).

That has a consequence worth stating plainly: **already-seeded projects keep
their stored figure until something touches their milestones.** The seed wrote
`85` for Coastline CRM, `92` for Tidal Notes, `64` for Pixelforge, and `47` for
Forge Components, and those are still what the API returns today. Their
milestone rows imply 67%, 67%, 67%, and 33% respectively, and each project will
snap to that figure the first time one of its milestones is created, edited, or
removed.

Backfilling them was considered and rejected: the seed and the migrations are
frozen for this phase, and a one-off `UPDATE` against a development database
would not survive `npm run db:reset` — it would look fixed and silently come
back. The honest position is that the derivation governs every write from here
on, and the four seeded rows are stale until first touched.

### The row lock, and why it is the transaction's first statement

The recompute is a read-modify-write, so unlike the like and follow counters it
is **not** self-serializing. Two milestones completed at the same instant each
counted a snapshot taken before the other committed, and the last writer stored
an already-stale figure — four milestones, two completed concurrently, and the
project landed on 25% instead of 50%. That was reproducible, and
`projects-concurrency.test.ts` still reproduces it if the lock is removed.

`SELECT … FOR UPDATE` on the project row fixes it, but **only if it runs
first**. Inserting or deleting a milestone takes a `FOR KEY SHARE` lock on the
parent project row through the foreign key; acquiring `FOR UPDATE` afterwards
is a lock _upgrade_, and two transactions each holding SHARE and each wanting
EXCLUSIVE deadlock. Taking the exclusive lock up front means the second
transaction blocks before it holds anything, so the two serialize instead.

## Counters

Six, each moved inside the same transaction as the row it summarizes — the rule
DATABASE.md states and the Phase 4 follow graph demonstrates.

| Counter                   | Moved by                                | What makes it safe                         |
| ------------------------- | --------------------------------------- | ------------------------------------------ |
| `Project.likesCount`      | `ProjectLike` insert / delete           | composite PK arbitrates; `SET x = x + 1`   |
| `Project.followersCount`  | `ProjectFollower` insert / delete       | same                                       |
| `Project.viewsCount`      | a deduplicated view                     | Redis `SET … NX` decides before the write  |
| `User.projectsCount`      | project create / soft-delete / transfer | `deletedAt: null` guard on `updateMany`    |
| `Project.progressPercent` | any milestone write                     | explicit project row lock                  |
| `Tag.usageCount`          | `ProjectTag` attach / detach            | `usageCount: { gt: 0 }` guard on decrement |

Three properties carried over from Phase 4:

- **The unique index is the arbiter**, not a pre-check. Eight simultaneous
  identical likes all attempt the insert; one commits, seven raise `P2002` and
  roll back — including their counter increments.
- **`{ increment: 1 }` compiles to `SET x = x + 1`** under a row lock, so two
  _different_ likers serialize rather than losing an update.
- **Decrements gate on a row actually being deleted**, which is what lets
  unlike and unfollow be idempotent without driving a counter negative.

### `projectsCount` — Phase 5 owns it

Phase 4 shipped `User.projectsCount` read-only and recorded the handoff. Phase 5
writes it. The definition matches the seed's exactly: **projects owned by that
user where `deletedAt IS NULL`**. Membership does not count — a collaborator on
someone else's project has not added to their own project count.

### `Tag.usageCount` starts wrong, on purpose

The seed creates `ProjectTag` rows without ever touching `usageCount`, so
seeded tags sit at `0` while genuinely being in use. Phase 5 maintains the
counter from here forward and does **not** backfill, because backfilling would
mean editing the seed or writing a data migration — both out of scope.

The consequence is handled rather than ignored: the decrement carries a
`usageCount: { gt: 0 }` guard in the same statement, so detaching a tag from a
seeded project cannot drive it negative.

## Tags attach, they do not accumulate

Phase 5 resolves tag references against **existing** `Tag` rows and rejects
unknown ones with a field-level 422. It never creates a tag from free text.

Both a display name ("Open Source") and a slug ("open-source") resolve, because
the frontend's `Project.tags` holds names and the seed derives its slugs the
same way `slugify` does.

Free-text tag creation is an unbounded-taxonomy decision — who may mint a tag,
how near-duplicates merge, what the moderation story is — and it belongs with
Phase 10 search, which is what actually consumes the taxonomy.

A tag filter on `GET /projects` that matches nothing returns an **empty page,
not a 422**. Filtering is a discovery affordance; erroring on a typo would be a
hostile way to say "no matches".

## Slugs

Server-derived from the title, lowercase, never client-supplied. The frontend
resolves a project by slug — `/projects/[projectId]` is matched against
`Project.slug`, not `.id` — so the slug is a public identifier, and letting a
client choose it would hand out the ability to squat reserved words.

- **Collisions get a numeric suffix**: `forge-components`, `forge-components-2`.
- **Reserved handles step past the reservation** rather than failing:
  `New` becomes `new-2`. `/projects/trending` is a real route declared before
  `/projects/:slug`, and `/projects/new` is already linked from the shipped
  sidebar.
- **Truncation shortens the base, never the suffix** — the suffix is the part
  that makes the slug unique.
- **The slug cannot be changed by `PATCH`.** Renaming would break every existing
  link, and this phase has no redirects.
- **No UUID fallback.** `GET /projects/:slug` looks up the slug column only.

Collisions are resolved by **retrying the whole transaction** with the next
candidate, not by looping inside it: a `P2002` aborts the surrounding
transaction in Postgres, so an in-transaction retry would run every subsequent
statement in a failed block.

## Views are deduplicated, not incremented

`POST /projects/:slug/view` exists because `Project.viewsCount` is rendered
prominently and no document gives it a write path. What it is _not_ is an open
increment endpoint, which would be a counter-inflation vector any client could
pull in a loop.

- **One counted view per identity per project per 24 hours.** The identity is
  the signed-in user, or the source address when anonymous.
- **Hashed before it becomes a Redis key**, so a cache dump does not reveal
  which addresses read which projects — the same treatment `brute-force.ts`
  gives an email.
- **`SET key 1 EX ttl NX`** is the whole mechanism: the write succeeds only if
  the key is absent, making "is this new?" one atomic round trip rather than a
  read-then-write race.
- **Owner views never count.** Someone refreshing their own project page is not
  an audience.
- **A project the caller cannot see cannot be viewed** — the endpoint runs
  through the same gate as everything else.

It **fails closed** when Redis is unavailable, the opposite of the brute-force
limiter. There, failing open costs a degraded defence but keeps people able to
sign in. Here, failing open would turn an outage into unbounded inflation,
while failing closed costs nothing but a temporarily flat counter.

## Member roles: read six, write three

Reads return the persisted `ProjectMemberRole` verbatim — all six values,
including `developer`, which the seed already writes.

Writes accept only `owner`, `collaborator`, and `contributor`, because
`project-team.tsx` maps exactly those three and would render an empty badge for
the others.

The API does not remap. Reporting a `developer` as a `collaborator` to make a
badge render would be lying about authorization state, and the badge is not
worth it. The gap is a frontend one, and closing it means adding three entries
to `ROLE_LABEL`.

## Projections

`project.view.ts` is the sole chokepoint. Nothing outside it turns a Prisma row
into an API response, and every projection is built **by construction** — none
starts from a row and deletes keys, because an omission list starts leaking the
day someone adds a column.

| Projection                  | Frontend type                                     | Used by                      |
| --------------------------- | ------------------------------------------------- | ---------------------------- |
| `toProjectView`             | `Project` (`types/project.ts`)                    | project page, listings       |
| `toTrendingProject`         | `TrendingProjectSummary` (`types/dashboard.ts`)   | dashboard widget             |
| `toProjectMember`           | `ProjectMember` (`types/project.ts`)              | the embedded `members` array |
| `toProjectMemberWithUser`   | `ProjectMemberWithUser` (`types/project-page.ts`) | members endpoint             |
| `toMilestone`               | `Milestone`                                       | roadmap                      |
| `toProjectUpdateWithAuthor` | `ProjectUpdateWithAuthor`                         | changelog                    |

Two shapes exist for the same data on purpose. `toProjectView` emits **nested,
un-suffixed** `metrics: { views, likes, followers }` because
`project-metrics-bar.tsx` reads `project.metrics.views`; `toTrendingProject`
emits a **flat `likesCount`** and a denormalized owner name because that is what
the dashboard widget reads. Both are real shipped contracts.

`deletedAt` is selected by the repository — the visibility gate needs it — and
never projected. Emitting it would let a client distinguish "soft-deleted" from
"never existed", which is exactly the distinction the 404 exists to erase.

## Links are protocol-restricted

`demoUrl`, `repositoryUrl`, and `documentationUrl` are validated as `http` or
`https` specifically, not merely as syntactically valid URLs.

`z.string().url()` accepts `javascript:alert(1)` — it is a well-formed URL —
and `project-hero.tsx` renders these fields directly as
`<a href={project.demoUrl}>`. Without the protocol check, "Live demo" is a
stored-XSS sink any authenticated user can load.

`coverImageUrl` and `gallery` are **not** URL-validated. The shipped fixtures
store opaque ids (`"gal_1"`) and the gallery component renders placeholder
tiles, so strict validation would make the API reject its own seed data. They
are bounded strings until Phase 11 issues real upload URLs.

## Notifications

`PortNotificationType` gains `like` and `project_invite`. Both have a single,
well-defined recipient, so both go through the Phase 4 port and are dropped by
the no-op until Phase 9.

`project_update` is deliberately **not** emitted. It is a fan-out — every
follower of a project receives one — and the port is single-recipient by design.
Looping over followers inside the projects service would put delivery fan-out in
the domain layer, which is the coupling the port exists to prevent. Phase 9 owns
fan-out and adds it there.

`NotificationEvent` gains optional `entityType` / `entityId`, mirroring the
schema's polymorphic target, so Phase 9 can persist a row without re-deriving
what the notification was about.

## What Phase 5 deliberately does not do

- **No posts, comments, or project discussion.** `ProjectDiscussion` renders
  from comment data, and comments are Phase 6. `Post.projectId` exists but no
  post is created here.
- **No feed integration.** Project updates are the project's own record; the
  social feed's milestone announcements are Phase 6 posts.
- **No realtime.** ARCHITECTURE §16 calls project events "potential future", no
  shipped component subscribes to any, and documenting a contract nothing
  honours would be worse than the silence.
- **No uploads.** `coverImageUrl` and `gallery` accept references only;
  Cloudinary is Phase 11.
- **No restore.** Soft delete has no inverse in this phase — undeleting is an
  admin surface with its own audit requirements (Phase 11).
- **No search.** `GET /projects` filters on indexed columns; full-text
  discovery is Phase 10.
- **No achievement awarding and no XP mutation.** `first-project` and
  `project-launcher` are seeded achievements, but the engine is Phase 10.
- **No pinned-project state.** No column exists. The shipped "Pinned projects"
  grid is the three most-liked, which `?sort=trending&limit=3` reproduces
  exactly — and the frontend's own comment concedes the same thing.
