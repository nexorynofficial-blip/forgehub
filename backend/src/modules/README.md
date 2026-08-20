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
middleware, Prisma/Redis clients) stays *outside* modules, in `utils/`,
`middleware/`, `config/`, and `database/`.

## Planned modules

Per BACKEND_TRD.md §4, in the phase order defined by
BACKEND_ARCHITECTURE.md §38:

| Module          | Phase | Status |
| --------------- | ----- | -------- |
| `auth`          | 3     | **done** |
| `users`         | 4     | **done** — absorbs `profiles` |
| `follows`       | 4     | **done** — absorbs blocking |
| `projects`      | 5     |          |
| `posts`         | 6     |          |
| `comments`      | 6     |          |
| `communities`   | 7     |          |
| `messages`      | 8     |          |
| `notifications` | 9     |          |
| `search`        | 10    |          |
| `achievements`  | 10    |          |
| `moderation`    | 11    |          |
| `admin`         | 11    |          |
| `uploads`       | 11    |          |
| `ai`            | 12    |          |

Two deviations from TRD §4's module list, both deliberate:

- **`profiles` folded into `users`.** `User` and `Profile` are separate tables
  but one joined view to the frontend; splitting them would put two
  repositories behind a single response.
- **`follows` moved from Phase 6 to Phase 4**, and absorbs `Block`. The
  earlier assignment was wrong: `feed-service.ts` filters the "following" feed
  through the follow graph, so the graph has to exist *before* the feed, not
  alongside it. Blocking lives here because it is the inverse relationship and
  shares the same integrity rules.

## Cross-module dependencies

Modules may depend on those above them, never below:

```
auth  ──►  (nothing)
users ──►  follows        (profile visibility consults the social graph)
follows ─► users          (targets are resolved by username; previews reuse
                           the shared user projection)
```

`users` and `follows` reference each other's **repositories and pure helpers**,
not each other's services, which keeps the cycle out of the business layer.
The shared projection in `users/user.view.ts` is the single place a Prisma row
becomes an API shape — later modules that need to render a user (posts,
comments, messages) should reuse `toUserSummary` rather than inventing their
own.

Each module's router mounts onto the v1 router in `src/routes/index.ts`.
