# ForgeHub Backend

REST + realtime API for the ForgeHub platform. Serves the existing Next.js
frontend at the repository root (`../src`), which is complete and unchanged.

**Status: Backend Phase 9 (Notifications) complete.** Phases 1–9 have landed:
infrastructure, the full database schema, authentication, the users/profiles +
follow-graph slice, the project aggregate, the social surface (posts, media,
polls, comments, engagement, the feed), communities — membership, roles,
ownership, rules, tags, events, pinned posts, and community posts — and
messaging: direct conversations, real-time delivery, typing indicators, read
receipts, unread counts, reactions, attachment references, presence, and search
within a conversation — and notifications: persisted in-app notifications with
real-time delivery, driven by every trigger across Phases 4–8 — and search:
one endpoint across users, projects, communities, posts, and tags, applying
each domain's own visibility rules in SQL — and moderation and
administration: reports, a review queue, the seven moderation actions, user
management, analytics, and an append-only audit trail. Achievements, uploads,
and AI are later phases and are deliberately not implemented.

## Stack

| Concern          | Choice                         |
| ---------------- | ------------------------------ |
| Runtime          | Node.js 22 LTS (ESM)           |
| Language         | TypeScript 5 (strict)          |
| HTTP             | Express 5                      |
| Database         | PostgreSQL 17 via Prisma 6     |
| Cache / pubsub   | Redis 7 via ioredis            |
| Realtime         | Socket.IO 4                    |
| Validation       | Zod 4                          |
| Password hashing | Argon2id via `@node-rs/argon2` |
| Tokens           | JWT (jose) + opaque refresh    |
| 2FA              | TOTP via otplib                |
| Logging          | Pino 10                        |
| Tests            | Vitest 3 + Supertest 7         |
| Docs             | OpenAPI 3.1 + Swagger UI       |
| Container        | Docker + Docker Compose        |

## Quick start

```bash
cd backend
cp .env.example .env          # then generate the three secrets — the shipped
                              # placeholders are rejected at boot on purpose:
                              #   openssl rand -base64 48   (x3)
                              # JWT_ACCESS_SECRET / JWT_REFRESH_SECRET /
                              # TWO_FACTOR_SECRET_KEY
npm install
docker compose up -d postgres redis
npm run prisma:deploy         # apply migrations
npm run prisma:seed           # development fixtures
npm run dev
```

Verify:

```bash
curl http://localhost:4000/health    # process is alive
curl http://localhost:4000/ready     # Postgres + Redis reachable
curl http://localhost:4000/api/v1    # API version mounted

# Sign in as a seeded user (password printed by the seed script)
curl -X POST http://localhost:4000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"ava@forgehub.dev","password":"DevPassword123","rememberMe":false}'
```

## Scripts

| Script                    | Purpose                                 |
| ------------------------- | --------------------------------------- |
| `npm run dev`             | Watch-mode dev server (tsx)             |
| `npm run build`           | Compile TypeScript to `dist/`           |
| `npm start`               | Run the compiled build                  |
| `npm run typecheck`       | `tsc --noEmit` over src + tests         |
| `npm test`                | Vitest suite                            |
| `npm run test:watch`      | Vitest in watch mode                    |
| `npm run prisma:generate` | Regenerate the Prisma client            |
| `npm run prisma:migrate`  | Create + apply a dev migration          |
| `npm run prisma:deploy`   | Apply migrations (CI / production)      |
| `npm run prisma:seed`     | Load development fixtures               |
| `npm run prisma:studio`   | Browse the database                     |
| `npm run db:reset`        | **Destructive** — drop, migrate, reseed |
| `npm run docker:up`       | Start all compose services              |
| `npm run docker:down`     | Stop them                               |

## Structure

Follows BACKEND_ARCHITECTURE.md §3–4.

```
backend/
  prisma/
    schema.prisma       48 models, 18 enums — see docs/DATABASE.md
    migrations/
    seed.ts             Idempotent development fixtures
  src/
    config/
      env.ts            Zod-validated environment (fails fast at boot)
      redis.ts          ioredis client + health check
      cookies.ts        Refresh / 2FA cookie policy
      openapi.ts        OpenAPI 3.1 document
    database/
      prisma.ts         PrismaClient singleton + health check
    middleware/
      auth.middleware.ts          requireAuth / optionalAuth
      role.middleware.ts          RBAC + ownership assertions
      error.middleware.ts         Centralized error normalization
      validation.middleware.ts    Zod body/query/params validation
      security.middleware.ts      Helmet, CORS, request id
      rate-limit.middleware.ts    Redis-backed rate limiting
      request-logger.middleware.ts
    modules/
      auth/             Phase 3 — routes/controller/service/repository/schema/types
      users/            Phase 4 — profiles, settings, preferences, projection layer
      follows/          Phase 4 — follow graph and blocking
      projects/         Phase 5 — projects, members, milestones, updates, engagement
      posts/            Phase 6 — posts, comments, polls, engagement, feed
      communities/      Phase 7 — membership, roles, rules, tags, events, pins
      messages/         Phase 8 — conversations, messages, receipts, reactions
      notifications/    Phase 9 — persistence, suppression, delivery, read state
      search/           Phase 10 — cross-entity search, visibility applied in SQL
      moderation/       Phase 11 — reports, actions, transactional audit
      admin/            Phase 11 — user management, analytics, audit-log access
    ports/
      notification.port.ts        Live as of Phase 9; no-op retained
    repositories/
      audit.repository.ts         Shared, cross-cutting audit writes
    integrations/
      email/            Provider abstraction + console transport
    sockets/
      socket.ts         Socket.IO server
      auth.socket.ts    Handshake authentication
      message.socket.ts Phase 8 — message/typing/read events and emits
      presence.socket.ts Phase 8 — Redis-backed online/offline tracking
      notification.socket.ts Phase 9 — notification:new delivery
    types/
      express.d.ts      `req.user` augmentation
    utils/
      password.ts       Argon2id hashing
      jwt.ts            Access-token signing / verification
      tokens.ts         Opaque tokens, hashing, backup codes, durations
      crypto.ts         AES-256-GCM for TOTP secrets
      totp.ts           TOTP primitives
      username.ts       Username derivation
      slug.ts           Project slug derivation
      brute-force.ts    Per-identifier lockout
      audit.ts          Audit event recording
      errors.ts         AppError + canonical error codes
      response.ts       Success / paginated / error envelopes
      pagination.ts     Offset + cursor pagination helpers
      logger.ts         Pino instance with secret redaction
      graceful-shutdown.ts
    routes/
      index.ts          v1 router factory; feature routers mount here
      health.routes.ts  /health, /ready
    jobs/               BullMQ queues and workers          (later phases)
    app.ts              Express app factory (testable, no port binding)
    server.ts           Entrypoint: connect deps, listen, register shutdown
  tests/                Vitest + Supertest suites
  docs/
    DATABASE.md                 Schema decisions
    AUTHENTICATION.md           Auth architecture
    USERS_AND_SOCIAL_GRAPH.md   Privacy, projection, blocking, counters
    PROJECTS.md                 Visibility, permissions, derived progress, counters
    POSTS_AND_FEED.md           Post visibility, tombstones, feed filters, counters
    COMMUNITIES.md              Community visibility, roles, resources, the posts seam
    MESSAGING.md                Conversation access, whoCanMessage, presence, receipts
    NOTIFICATIONS.md            Suppression rules, collapse policy, the port, fan-out
    SEARCH.md                   Entities, visibility model, ranking, the D1–D14 rulings
    MODERATION.md               Reports, lifecycle, actions, audit, the blocking exception
    ADMIN.md                    Users, role boundary, analytics, audit-log access
```

Business logic lives in module services, database access in module
repositories, and controllers stay thin — see `src/modules/README.md` for the
per-module layout and layer rules.

## API conventions

Every `/api/v1` response uses one envelope (BACKEND_TRD.md §7):

```jsonc
// success
{ "success": true, "data": { }, "message": "Operation completed successfully", "error": null }

// collection — large collections are never returned unpaginated (§8)
{ "success": true, "data": [ ], "message": "…", "error": null,
  "pagination": { "page": 1, "limit": 20, "total": 100, "totalPages": 5 } }

// failure
{ "success": false, "data": null,
  "error": { "code": "VALIDATION_ERROR", "message": "…",
             "details": [{ "field": "body.email", "message": "Invalid email" }] } }
```

The envelope is a deliberate superset. BACKEND_TRD.md §7 specifies
`{ success, data, message }`; the finished frontend already types its
contract as `{ data, error }` in `src/types/common.ts`. Carrying every key
satisfies both without changing frontend code.

Clients branch on `error.code` (see `src/utils/errors.ts`), never on
`error.message`. Stack traces are never serialized, and in production the
message for any 5xx is replaced with a generic string.

## Endpoints

| Method | Path                    | Purpose                                                                                                                           |
| ------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/health`               | Liveness. Checks nothing external — always 200 if up.                                                                             |
| GET    | `/ready`                | Readiness. 200 only if Postgres **and** Redis respond.                                                                            |
| GET    | `/api/v1`               | Version discovery.                                                                                                                |
| GET    | `/api/v1/openapi.json`  | OpenAPI 3.1 document.                                                                                                             |
| GET    | `/api/v1/docs`          | Swagger UI. Disabled in production.                                                                                               |
| —      | `/api/v1/auth/*`        | 17 authentication endpoints — see docs/AUTHENTICATION.md.                                                                         |
| —      | `/api/v1/users/*`       | 12 profile / settings / social-graph endpoints — see docs/USERS_AND_SOCIAL_GRAPH.md.                                              |
| —      | `/api/v1/projects/*`    | 24 operations over 13 paths, plus `/users/:username/projects`. See docs/PROJECTS.md.                                              |
| —      | `/api/v1/posts/*`       | Posts, comments, likes, bookmarks, polls. See docs/POSTS_AND_FEED.md.                                                             |
| —      | `/api/v1/comments/*`    | Comment edit, delete, replies, likes.                                                                                             |
| —      | `/api/v1/feed`          | The social feed and its six filters, plus `/feed/new-count`.                                                                      |
| —      | `/api/v1/communities/*` | 24 operations over 15 paths — discovery, membership, roles, ownership, rules, tags, events, pins, posts. See docs/COMMUNITIES.md. |

Probes sit at the root, not under `/api/v1`, so orchestrator config does not
change when the API version does. They are also registered _before_ the rate
limiter — a throttled health check would cause false restarts.

## Authentication

Full rationale in [docs/AUTHENTICATION.md](docs/AUTHENTICATION.md). The short
version:

- **Access token** — short-lived JWT (15m), returned in the JSON body, sent
  back as `Authorization: Bearer <token>`.
- **Refresh token** — opaque, rotated on every use, stored only as a keyed
  hash, and transported **only** as an httpOnly cookie. It never appears in a
  response body.
- **Reuse detection** — presenting an already-rotated refresh token revokes
  the entire session, on the assumption that it leaked.
- **Sessions** — one per device, listable and individually revocable. Logout
  and revocation take effect immediately, because every authenticated request
  re-reads the session.
- **2FA** — full TOTP enrollment, login challenge, and single-use backup
  codes. Secrets are encrypted at rest with AES-256-GCM.
- **RBAC** — the frontend's six roles. `guest` is never persisted.
- **Brute force** — per-identifier progressive lockout in Redis, separate from
  the per-source HTTP rate limiter.
- **No enumeration** — login, registration, password reset, and verification
  resend all respond identically whether or not an account exists.

## Security foundation

- **Helmet** — CSP (`default-src 'none'`), no framing, no referrer; HSTS in production only.
- **CORS** — strict allowlist from `CORS_ORIGIN`; credentials enabled for the refresh cookie.
- **Rate limiting** — Redis-backed so limits hold across replicas and restarts, with a tighter budget on the credential routes.
- **Body limits** — `BODY_LIMIT` (default 1mb) caps JSON/urlencoded payloads.
- **Env validation** — the process refuses to boot on invalid config. JWT and 2FA secrets must be ≥32 chars **and must not still be the `.env.example` placeholder**: a long placeholder passes a length check, so `cp .env.example .env` would otherwise start the server on a signing key and an encryption key published in this repository.
- **Log redaction** — auth headers, cookies, and every password/token/secret field are censored by Pino, at both top level and one level of nesting.
- **Correlation ids** — every response carries `X-Request-Id`, honoring an upstream value when present.
- **Audit logging** — 20 security-sensitive actions recorded to an append-only table.

## Docker

`docker compose up -d` provides `backend`, `postgres`, and `redis`. Postgres
and Redis both use named volumes, so data survives `docker compose down`.
Credentials come from `.env` — nothing is hardcoded. The backend waits on
both dependencies' healthchecks before starting, and the image runs as the
non-root `node` user.

Both build stages use `npm ci --ignore-scripts`, which is why the password
hasher is `@node-rs/argon2` (prebuilt NAPI binaries) rather than a node-gyp
module that would need a postinstall step.

## Testing

```bash
npm test
```

675 tests across 28 files:

| Suite                          | Covers                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| `health.test.ts`               | Liveness, readiness, dependency-down → 503                                         |
| `api.test.ts`                  | Versioning, envelope, malformed JSON, headers, CORS, OpenAPI                       |
| `config.test.ts`               | Environment validation and defaults                                                |
| `pagination.test.ts`           | Offset + cursor helpers                                                            |
| `database.test.ts`             | Constraints, cascades, restrict/set-null, against real Postgres                    |
| `auth-unit.test.ts`            | Argon2, JWT, opaque tokens, backup codes, usernames, AES-GCM, TOTP                 |
| `auth.test.ts`                 | Full registration → verify → login → refresh → logout flows, resets, sessions, 2FA |
| `auth-security.test.ts`        | Credential exposure, log redaction, RBAC, ownership, account status, OpenAPI sync  |
| `auth-rate-limit.test.ts`      | Per-source HTTP throttling                                                         |
| `auth-brute-force.test.ts`     | Per-identifier lockout against real Redis                                          |
| `socket-auth.test.ts`          | Socket.IO handshake, room isolation, impersonation attempts                        |
| `users-unit.test.ts`           | Username rules, visibility resolution, email exposure, profile completion          |
| `users.test.ts`                | Profile read/update, username change, settings, notification preferences           |
| `follows.test.ts`              | Follow/unfollow, blocking, pagination, counters under real concurrency             |
| `users-security.test.ts`       | Ownership, followers-only redaction, block opacity, admin override, projection     |
| `projects-unit.test.ts`        | Slug derivation, project visibility, the permission table, write schemas           |
| `projects.test.ts`             | Create → read → patch → soft-delete, slugs, tags, transfer, listings, trending     |
| `project-members.test.ts`      | Team CRUD, leaving, role rules, and the ownership no-drift guards                  |
| `project-roadmap.test.ts`      | Milestones and `progressPercent` derived transactionally from them                 |
| `project-updates.test.ts`      | Changelog with cursor paging, plus likes, followers, and deduplicated views        |
| `projects-security.test.ts`    | Private/unlisted 404s, blocking, admin override, projection leaks, OpenAPI sync    |
| `projects-concurrency.test.ts` | Counters, slug races, and lost updates under real parallel requests                |
| `posts-unit.test.ts`           | Post visibility, mention parsing, write schemas and what they strip                |
| `posts.test.ts`                | Create → read → edit → soft-delete, media, polls, likes, bookmarks                 |
| `post-comments.test.ts`        | Threads, one-level replies, tombstones, moderation, comment likes, voting          |
| `feed.test.ts`                 | All six filters, cursor paging, feed visibility, the new-count watermark           |
| `posts-security.test.ts`       | Private/community 404s, blocking, admin limits, projection leaks, OpenAPI sync     |
| `posts-concurrency.test.ts`    | Like/comment/bookmark/vote counters under real parallel requests                   |

HTTP-only suites mock Postgres and Redis so they stay hermetic. The auth,
database, and socket suites talk to real infrastructure — `docker compose up -d
postgres redis` before running them. Everything they create is namespaced and
removed afterwards, so they are safe to run against a seeded development
database.
