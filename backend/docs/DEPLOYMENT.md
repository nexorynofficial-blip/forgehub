# Deployment

Phase 14. Running ForgeHub's backend — `BACKEND_TRD.md` §33 (Environment
Management), §34 (Docker), §35 (Health Checks); `BACKEND_ARCHITECTURE.md` §31
(Observability), §32 (Configuration), §36 (Deployment Architecture), and the
roadmap entry at §38 naming this phase **Deployment**.

Every command below is one this repository actually supports and that was run
during the phase. Nothing here is aspirational.

## What the specifications ask for, and what they leave open

| Source                        | Requires                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BACKEND_TRD.md` §34          | Docker Compose with **backend, PostgreSQL, Redis**; _"Additional services only when required"_; a documented start command                                               |
| `BACKEND_TRD.md` §33          | environment variables; a committed `.env.example`; never commit `.env`, secrets, keys, passwords                                                                         |
| `BACKEND_TRD.md` §35          | `GET /health`; a deeper readiness endpoint **may** verify PostgreSQL, Redis, critical dependencies                                                                       |
| `BACKEND_ARCHITECTURE.md` §36 | development on Compose; production architecture **should allow** load balancer, multiple instances, managed Postgres/Redis, external storage and email, optional workers |
| `BACKEND_ARCHITECTURE.md` §31 | request ids; **structured JSON logging in production**                                                                                                                   |
| `BACKEND_ARCHITECTURE.md` §32 | all environment-specific configuration from environment variables                                                                                                        |

**No hosting provider is named anywhere**, and neither is CI/CD. §36 says
production _"should allow"_ managed services and horizontal scaling — a
constraint on the architecture, not an instruction to build a platform. So this
phase stays **provider-neutral**: a correct container image, correct
configuration propagation, and documented operations. There is no
`.github/workflows`, no Terraform, and no cloud-specific manifest, because
no authoritative source asks for one.

## Architecture

```
                    ┌──────────────────────────┐
   client ────────► │  backend (node:22-alpine)│
                    │  dist/server.js, non-root│
                    │  HTTP + Socket.IO :4000  │
                    └───────┬──────────┬───────┘
                            │          │
              ┌─────────────▼──┐   ┌───▼──────────────┐
              │ PostgreSQL 17  │   │    Redis 7       │
              │ postgres_data  │   │   redis_data     │
              └────────────────┘   └──────────────────┘
```

- **Runtime** — Node 22, ES modules, compiled JavaScript. The container runs
  `node dist/server.js` as the unprivileged `node` user (uid 1000). No
  TypeScript, no `tsx`, no watcher, and **no source bind mount** — the image is
  self-contained, which is what lets the same artefact run anywhere.
- **PostgreSQL 17** and **Redis 7**, each with a healthcheck that gates backend
  startup and a named volume that survives `docker compose down`.
- **Startup order is enforced.** The backend declares
  `depends_on: condition: service_healthy` for both, because `bootstrap()`
  connects to the database and Redis _before_ binding the port. Starting early
  makes the process exit non-zero and restart-loop until Postgres wins the race.

### The image

`Dockerfile` is a three-stage build:

| Stage     | Does                                                              |
| --------- | ----------------------------------------------------------------- |
| `deps`    | `npm ci --omit=dev` — production modules only                     |
| `build`   | full toolchain, `prisma generate`, `tsc -p tsconfig.build.json`   |
| `runtime` | copies pruned `node_modules`, the generated Prisma client, `dist` |

The generated Prisma client is copied from `build` rather than regenerated,
because it lives inside `node_modules` and is not reproducible from the pruned
`deps` stage. `.dockerignore` keeps `tests`, `.env`, `.git`, `dist`, and
`coverage` out of the build context.

## Quick start

From `backend/`:

```bash
cp .env.example .env          # then edit — see "Secrets" below
docker compose up -d          # postgres, redis, backend
npm run prisma:deploy         # apply migrations (see below)
curl http://localhost:4000/health
```

`docker compose up -d` is TRD §34's _"documented command"_. It builds the image
on first run.

## Environment

Configuration is entirely environment-driven (ARCHITECTURE §32). `config/env.ts`
parses and validates it **once at import**, and calls `process.exit(1)` with the
offending variable names when validation fails — the process refuses to boot
rather than failing later on the first request that touches a bad value.

### Required — no default, boot fails without them

| Variable                                                                            | Notes                                                 |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `DATABASE_URL`                                                                      | must start `postgres`                                 |
| `REDIS_URL`                                                                         | must start `redis`                                    |
| `JWT_ACCESS_SECRET`                                                                 | ≥32 chars, and not the `.env.example` placeholder     |
| `JWT_REFRESH_SECRET`                                                                | ≥32 chars; HMAC pepper for stored token hashes        |
| `TWO_FACTOR_SECRET_KEY`                                                             | ≥32 chars; AES-256-GCM key for TOTP secrets at rest   |
| `RESEND_API_KEY`                                                                    | **only when `EMAIL_PROVIDER=resend`** — see below     |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` | **only when `GOOGLE_OAUTH_ENABLED=true`** — see below |

Compose additionally requires `POSTGRES_USER`, `POSTGRES_PASSWORD`, and
`POSTGRES_DB` for the database service. None of the three carries a default, so
a missing value fails loudly instead of provisioning a database with a guessed
password.

### Selected optional variables

| Variable                  | Default                 | Effect                                          |
| ------------------------- | ----------------------- | ----------------------------------------------- |
| `NODE_ENV`                | `development`           | see the warning below                           |
| `PORT` / `HOST`           | `4000` / `0.0.0.0`      | listen address                                  |
| `CORS_ORIGIN`             | `http://localhost:3000` | comma-separated allowlist                       |
| `LOG_LEVEL`               | `info`                  | pino level                                      |
| `COOKIE_SECURE`           | _unset_                 | unset means **on in production**, off elsewhere |
| `COOKIE_SAMESITE`         | `lax`                   | `none` also requires `COOKIE_SECURE=true`       |
| `EMAIL_PROVIDER`          | `console`               | `console` or `resend` — see **Email** below     |
| `AI_PROVIDER`             | `local`                 | `local` or `disabled`                           |
| `GOOGLE_OAUTH_ENABLED`    | `false`                 | `true` makes the three Google values required   |
| `OAUTH_STATE_COOKIE_NAME` | `forgehub_oauth_state`  | short-lived cookie for the OAuth round trip     |
| `SHUTDOWN_TIMEOUT_MS`     | `10000`                 | hard ceiling on draining                        |

`COOKIE_SECURE` and `COOKIE_DOMAIN` are deliberately **not** forwarded by
Compose. Leaving `COOKIE_SECURE` unset is what makes cookies `Secure`
automatically under `NODE_ENV=production` (`config/cookies.ts` reads
`env.COOKIE_SECURE ?? isProduction`), and an unset `COOKIE_DOMAIN` yields a
host-only cookie. Both defaults are the safe ones; set them in `.env` if you
terminate TLS somewhere unusual or serve the API from a parent domain.

### ⚠ `NODE_ENV` defaults to `development` in Compose

`docker-compose.yml` is the **development** environment — its own header says
so, and it passes `NODE_ENV: ${NODE_ENV:-development}`, which overrides the
`ENV NODE_ENV=production` baked into the image.

Consequences if you deploy this file unchanged: cookies are not `Secure`,
internal 5xx messages are returned verbatim instead of masked, and the logger
attempts pretty-printing. **Set `NODE_ENV=production` in `.env`** before
running Compose anywhere real:

```bash
NODE_ENV=production
COOKIE_SAMESITE=none   # if the API and frontend are on different sites
CORS_ORIGIN=https://your-frontend.example
APP_URL=https://your-frontend.example
```

Running the image directly (`docker run`) rather than through Compose gets
`NODE_ENV=production` from the Dockerfile with no extra step.

### Secrets

TRD §33: never commit `.env`, secrets, API keys, database passwords, or JWT
secrets. `.env` is in `.gitignore`; only `.env.example` is committed, and every
credential in it is the literal `replace_me…` placeholder that `config/env.ts`
**explicitly rejects** — so `cp .env.example .env && docker compose up` fails
fast rather than booting on a signing key published in this repository.

Generate real values:

```bash
openssl rand -base64 48   # once each for the three secrets
```

`tests/deployment.test.ts` asserts that every credential Compose forwards is a
`${VAR}` reference with **no inline default**, so no deployment can silently
fall back to a shared fallback credential.

## Email

**Transport: Resend, over its HTTP API.**

```bash
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_...                          # from the Resend dashboard
EMAIL_FROM=ForgeHub <no-reply@mail.your-domain>
APP_URL=https://app.your-domain
```

Implemented against `fetch` rather than the `resend` SDK: the integration is
one POST to one endpoint with a bearer token, and Node 22 ships `fetch`
natively, so an SDK would add a dependency to save nothing. **The dependency
count for email is zero.**

### You must verify a sending domain

Resend delivers only from a domain verified in its dashboard, which means
publishing the DNS records it gives you. Until that is done, every message is
rejected at the API. The schema refuses to boot if `EMAIL_FROM` is still the
built-in `forgehub.dev` default while `EMAIL_PROVIDER=resend`, because that
domain belongs to nobody and every send would bounce.

### Configuration that cannot silently fail

`config/env.ts` refuses to start the process in three cases, all of which
previously produced a deployment that looked healthy and sent nothing:

| Configuration                                         | Result     |
| ----------------------------------------------------- | ---------- |
| `EMAIL_PROVIDER=resend` with no `RESEND_API_KEY`      | boot fails |
| `EMAIL_PROVIDER=resend` with the default `EMAIL_FROM` | boot fails |
| `NODE_ENV=production` with `EMAIL_PROVIDER=console`   | boot fails |

The last is the important one. The console transport refuses to print in
production — a reset link in container logs is a credential leak — so selecting
it there drops every message. That is now a refusal to start rather than a
silent loss.

`RESEND_API_KEY` is forwarded by Compose as `${RESEND_API_KEY}` with no inline
default. An unset variable substitutes as the empty string, which the schema
reads as "not configured", so the line is inert until you select resend.

### Which flows depend on it

Email verification, password reset, and the security alert sent after a password
change or a 2FA toggle. The frontend routes those links target —
`/verify-email?token=…` and `/reset-password?token=…` — both exist and consume
their token; `tests/email-unit.test.ts` asserts the generated paths match.

Verification currently gates no route (`requireVerifiedEmail` is defined but
applied nowhere), so unverified users are not locked out while DNS propagates.

## Google sign-in

Optional and **off by default**. Everything below can be skipped; the app runs
with email and password alone, and the Google button simply is not rendered.

### The redirect URI

Google matches this string **exactly** — scheme, host, port, path, no trailing
slash. It is the backend's own callback route, not a frontend page:

|            |                                                         |
| ---------- | ------------------------------------------------------- |
| Local      | `http://localhost:4000/api/v1/auth/google/callback`     |
| Production | `https://api.<your-domain>/api/v1/auth/google/callback` |

Substitute your own API host. If the API is served under a path prefix by a
reverse proxy, the registered URI must include that prefix — the value in
`GOOGLE_OAUTH_REDIRECT_URI` and the value registered in Google must be the
same string, character for character, or Google refuses the callback with
`redirect_uri_mismatch`.

### Google Cloud Console setup

1. Open [console.cloud.google.com](https://console.cloud.google.com).
2. Create a project, or select an existing one, from the project picker.
3. Go to **APIs & Services → OAuth consent screen** (newer consoles present
   this as **Google Auth Platform → Branding**). Fill in the app name, the
   user-support email, and the developer contact email.
4. Choose the audience. **External** is what a public site needs; **Internal**
   is available only to Google Workspace organisations and restricts sign-in
   to that organisation. While the app is in **Testing**, only the accounts
   listed under **Audience → Test users** can sign in — add your own address
   there, or publish the app when you are ready.
5. Under **Data access** (older consoles: **Scopes**), confirm only
   `openid`, `.../auth/userinfo.email`, and `.../auth/userinfo.profile`. These
   are non-sensitive and need no verification review. **Do not enable any
   Google API** — this integration calls none.
6. Go to **APIs & Services → Credentials → Create credentials → OAuth client
   ID**.
7. Application type: **Web application**. Name it something recognisable.
8. **Authorized redirect URIs → Add URI**: paste the callback URL from the
   table above. Add both the local and the production URI if one client is
   serving both.
9. **Authorized JavaScript origins**: leave empty. That field is for
   browser-side Google libraries, and this flow uses none — the browser never
   calls Google from JavaScript.
10. Copy the **Client ID** and **Client secret** into the backend's
    git-ignored `.env`:

    ```env
    GOOGLE_OAUTH_ENABLED=true
    GOOGLE_OAUTH_CLIENT_ID=...apps.googleusercontent.com
    GOOGLE_OAUTH_CLIENT_SECRET=...
    GOOGLE_OAUTH_REDIRECT_URI=http://localhost:4000/api/v1/auth/google/callback
    ```

11. Set the frontend's matching flag in its own git-ignored `.env.local`, then
    rebuild the frontend — this value is inlined at build time:

    ```env
    NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED=true
    ```

12. Restart the backend. Boot fails loudly and names the variable if anything
    is missing.
13. Open `/login`. "Continue with Google" now goes to Google.

The client secret is a real credential: `.env` is git-ignored, and the schema
rejects the published `.env.example` placeholder so a copied template cannot
boot as if it were configured.

### Turning it off

Set `GOOGLE_OAUTH_ENABLED=false` (or unset it) and rebuild the frontend with
`NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED=false`. The routes stay mounted but refuse,
redirecting to the frontend with `oauth_unavailable`, so an old bookmark
degrades to a readable message rather than an error page.

The two flags can disagree without breaking anything, which is deliberate —
one is baked into a bundle and the other is read at boot, so they cannot be
changed atomically.

### Both flags must be set for the build, not just the runtime

`NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED` is inlined into the browser bundle by
`next build`, exactly like the two API URLs. Setting it only in the runtime
environment has no effect. See "Frontend production environment" below.

## First platform administrator

Registration always assigns `member`, promotion requires an existing
`platform_admin`, and the seed refuses to run in production. A fresh production
database therefore has no administrator and no supported way to acquire one.

```bash
npm run admin:bootstrap -- --email founder@your-domain
```

Run from a checkout with `DATABASE_URL` pointed at the target database — the
same access migrations already need. `scripts/` is excluded from the runtime
image, for the same reason the Prisma CLI is.

The command:

- promotes an **existing** account; it never creates one and never sets a password
- **refuses to run once any platform admin exists**, which is what keeps it a
  bootstrap rather than a permanent unaudited escalation path
- runs at `Serializable` isolation, so two concurrent runs cannot both promote
- writes a `ROLE_CHANGED` audit row with a null actor and `via: admin:bootstrap`,
  recording that the grant came from an operator rather than a signed-in user

Every later role change goes through `PATCH /admin/users/:id/role`, where it is
attributable to a person.

## Database migrations

**Mechanism: `prisma migrate deploy`, run as a one-off deployment step.**

```bash
npm run prisma:deploy        # prisma migrate deploy
```

The script already existed; this phase documents it as the production
mechanism and states what it is not.

- **Never `prisma migrate dev`** in production — it is interactive, it can
  generate new migration files, and it will reset a drifted database.
- **Not run at container startup.** The backend's `CMD` is
  `node dist/server.js` and nothing else. That is deliberate: §36 requires the
  production architecture to allow _"multiple backend instances"_, and N
  instances racing `migrate deploy` on boot is a schema race. Migrations are a
  deployment step that runs **once**, before or alongside the rollout.

### Run it from a checkout, not from the runtime image

```bash
# with DATABASE_URL pointing at the target database
npm ci
npm run prisma:deploy
```

**The runtime image cannot apply migrations, by construction.** This was
verified during Phase 14 rather than assumed:

```
$ docker compose run --rm backend npx prisma migrate deploy
Error: Can't write to /app/node_modules/@prisma/engines
       please make sure you install "prisma" with the right permissions.
```

Two deliberate properties of the image cause that, and neither should be
changed to work around it: the `deps` stage installs with `--omit=dev`, so the
`prisma` **CLI** (a devDependency) is absent — only the generated client ships
— and the container runs as the unprivileged `node` user, so `npx` cannot
install the CLI at runtime either. A runtime image that could rewrite its own
`node_modules` and reach the database with migration privileges is a larger
attack surface than one that cannot.

So migrations run from somewhere that has the repository and its
devDependencies: a CI job, a release runner, or a maintainer's checkout with
`DATABASE_URL` pointed at the target. That is also what makes the "run once"
property easy to honour — it is one job, not N replicas racing on boot.

There are **2 migrations**. `npx prisma migrate status` reports whether the
database matches them, and `prisma migrate deploy` is idempotent: re-running it
against an up-to-date database applies nothing.

## Health and readiness

Two endpoints, mounted at the root rather than under `/api/v1` so orchestrator
probes do not move when the API version does.

| Endpoint  | Checks                   | Use as    |
| --------- | ------------------------ | --------- |
| `/health` | nothing — process is up  | liveness  |
| `/ready`  | PostgreSQL **and** Redis | readiness |

`/health` deliberately touches no dependency: a failing database should not
cause an orchestrator to kill and restart an otherwise healthy container. That
is what `/ready` is for — it returns **503** with `{ database, redis }` status
when either is down, so a load balancer stops routing to the instance until it
recovers.

The image also carries its own `HEALTHCHECK` hitting `/health`, which is what
`docker ps` reports as `(healthy)`.

```bash
curl http://localhost:4000/health   # 200
curl -i http://localhost:4000/ready # 200, or 503 with which dependency is down
```

## Shutdown and restart

`registerShutdownHandlers` traps **SIGTERM** and **SIGINT** (and treats an
unhandled rejection or uncaught exception the same way) and drains in a fixed
order:

1. Socket.IO — `closeSocketServer()`
2. the HTTP server — stop accepting, finish in-flight
3. Prisma and Redis together — `Promise.allSettled`

The order is the contract: releasing the database first would let an in-flight
request reach a closed handle. A second signal while draining is ignored rather
than restarting the sequence, and `SHUTDOWN_TIMEOUT_MS` (default 10s) is a hard
ceiling — if draining stalls on a hung keep-alive socket the process exits
non-zero instead of waiting for SIGKILL.

```bash
docker compose restart backend   # SIGTERM, drain, restart
docker compose stop backend      # SIGTERM, drain, stay down
docker compose down              # stop and remove containers — volumes survive
```

`docker compose down -v` **destroys `postgres_data` and `redis_data`.** It is
never part of a deployment.

## Logs

```bash
npm run docker:logs                     # docker compose logs -f backend
docker compose logs --tail=100 backend
```

Pino, structured (ARCHITECTURE §31). In production it emits **NDJSON** to
stdout; `pino-pretty` is a devDependency and is absent from the production
image, so the container logs machine-readable lines that a collector can ingest
directly. Every request carries a request id.

Redaction is configured centrally: `password`, `passwordHash`, `token`,
`accessToken`, `refreshToken`, `secret`, `backupCode`, and the
`authorization`/`cookie` headers never reach the log sink. Two paths take extra
care beyond that list — the console email transport refuses to print
verification links in production, and `AIService` logs only
`{ err, provider, capability }`, never the user text it was given.

## Persistent data

| Volume                  | Holds               |
| ----------------------- | ------------------- |
| `backend_postgres_data` | the entire database |
| `backend_redis_data`    | Redis AOF           |

Both survive `docker compose down`, image rebuilds, and container recreation.
Backup and restore are not automated by this repository; for a Compose
deployment the conventional approach is `pg_dump` against the Postgres
container. Redis holds only rate-limit counters, brute-force state, and
presence — all reconstructible, none worth restoring.

## Rebuilding after a code change

The image does not bind-mount source, so **code changes require a rebuild**.
This is the correct behaviour for a production artefact and the reason Phase 13
found a container running four-day-old code:

```bash
docker compose build backend
docker compose up -d backend    # recreates only the backend container
```

Neither command touches the volumes or the database.

## Frontend production environment

Public by construction — `NEXT_PUBLIC_*` values are inlined into the browser
bundle, so none of these may ever hold a secret:

```bash
NEXT_PUBLIC_API_URL=https://api.your-domain/api/v1   # includes the version prefix
NEXT_PUBLIC_SOCKET_URL=https://api.your-domain       # the server ROOT, no prefix
NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED=true                # only if Google sign-in is on
```

**Set them in the build environment.** They are baked in when `next build` runs,
not read at startup, so setting them only at runtime has no effect.

A production build now **fails** rather than falling back. `next.config.ts`
validates during `PHASE_PRODUCTION_BUILD` and `src/lib/env.ts` validates again
from module scope; both apply the same rules from `src/lib/env-contract.ts`.
A build is refused when either variable is unset, is not an absolute http(s)
URL, points at loopback, or — for the socket URL — carries a path, which would
produce `/api/v1/socket.io` and fail the handshake.

`NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED` is not validated — it is a boolean whose
safe default is "off", and an unset value simply hides the Google button.
It is listed here because it is inlined the same way: flipping it on a
running deployment does nothing until the next build.

Previously an omitted variable baked `http://localhost:4000` into the bundle:
the build succeeded, the deployment reported healthy, and every request from a
real browser went to the visitor's own machine.

## Backend replicas

```text
backend application replicas = 1
```

Socket.IO is configured with **no Redis adapter**, so rooms are process-local.
With two instances, a message published to `user:<id>` on instance A never
reaches that user's socket on instance B — chat silently misses messages,
presence disagrees, and notification fan-out is partial. HTTP is stateless and
would scale horizontally; realtime is what caps the deployment at one.

Single-instance realtime is the supported topology for initial launch. Adding a
replica requires the adapter first.

## Known operational limitations

- **`NODE_ENV` defaults to `development` in Compose**, above. The single
  biggest deployment footgun in this repository.
- **No CI/CD.** No authoritative source requires it and none is provided.
  Deployment validation is the host suite plus a Docker build.
- **Migrations are manual.** Deliberate, so multiple instances cannot race —
  but it does mean a rollout that forgets `prisma migrate deploy` starts against
  an old schema.
- **No background workers.** §36 lists them as optional; `src/jobs/` is empty
  and nothing is queued.
- **Email requires a Resend account.** The transport exists; the credential and
  the verified sending domain are yours to supply. See **Email** above.
- **Single-node Socket.IO.** No Redis adapter is configured, so the deployment
  is capped at one backend replica — see **Backend replicas** above. §36 asks
  that the architecture _allow_ multiple instances; HTTP scales horizontally
  today, realtime does not.
