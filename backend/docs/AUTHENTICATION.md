# Authentication architecture

Decisions behind `src/modules/auth/` (Backend Phase 3). Read alongside
BACKEND_TRD.md §12–17 and BACKEND_ARCHITECTURE.md §17–18, §26–28.

## Shape of the system

```
POST /auth/login
      │
      ├─ rate limiter (per source address)
      ├─ Zod validation
      ├─ brute-force check (per identifier)
      │
      ▼
  auth.service ── Argon2id verify ──► auth.repository ──► Prisma ──► Postgres
      │
      ├─ 2FA enabled?  ──► challenge token in Redis ──► 200 { twoFactorRequired }
      │
      └─ session + refresh token ──► controller
                                        │
                                        ├─ access JWT   → response body
                                        └─ refresh token → httpOnly cookie
```

Controllers hold no business logic; the service holds every authorization
decision; the repository is the only thing that touches Prisma.

## Access tokens

Short-lived JWTs, HS256, signed with `JWT_ACCESS_SECRET`. Default lifetime 15
minutes (`JWT_ACCESS_EXPIRES`).

Claims: `sub` (user id), `sid` (session id), `role`, `jti`, plus `iss`/`aud`
pinned to `forgehub`/`forgehub-api`. Verification pins `algorithms: ["HS256"]`
so a token declaring `alg: "none"` — or any other algorithm — is rejected
rather than trusted.

**The token is not the authority.** `requireAuth` verifies it and then re-reads
the user and session from the database on every request. That costs a query,
and buys three things a self-contained token cannot give:

- logout takes effect immediately instead of lingering for up to 15 minutes,
- a ban applies on the banned user's _next request_, not their next login,
- a role change (promotion or demotion) cannot be outrun by a stale token.

## Refresh tokens

Opaque 256-bit random strings — **not** JWTs. A self-contained refresh JWT
could not be revoked before expiry, which TRD §13 requires.

Only a hash is stored. The hash is an HMAC-SHA256 keyed by
`JWT_REFRESH_SECRET`, which acts as a server-side pepper: a database dump on
its own cannot be used to verify guessed tokens. That is what
`JWT_REFRESH_SECRET` is for — it signs nothing.

### Cookie transport

The refresh token is returned **only** as an httpOnly cookie and never appears
in a JSON body. The access token is short-lived and held in memory by the
client; the long-lived credential is unreadable by any script, including an
injected one.

| Attribute  | Value                                               | Why                                                                                                                                                                         |
| ---------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `httpOnly` | always `true`                                       | Not reachable from JavaScript.                                                                                                                                              |
| `secure`   | `COOKIE_SECURE`, defaulting to `true` in production | `http://localhost` would reject a `Secure` cookie in development.                                                                                                           |
| `sameSite` | `COOKIE_SAMESITE`, default `lax`                    | `localhost:3000 → localhost:4000` and `app.example.com → api.example.com` are both _same-site_, so `lax` works. A genuinely cross-site split needs `none` **and** `secure`. |
| `path`     | `AUTH_COOKIE_PATH`, default `/api/v1/auth`          | The credential is only sent to the endpoints that consume it, not on every API call.                                                                                        |
| `maxAge`   | 7 days, or 30 with "Remember me"                    | Matches what the shipped login form promises the user.                                                                                                                      |

Clearing repeats path/domain/sameSite/secure exactly — a browser treats a
cookie with a different path as a different cookie and would leave the
original in place.

## Rotation and reuse detection

Every refresh is single-use. The presented token is revoked, a new one is
issued, and `replacedByTokenId` links the two so the chain stays traceable.

Presenting a token that has **already been rotated away** means one of two
things: a client bug, or the token was stolen and the legitimate client
already spent it. There is no way to tell which, so the safe response is the
same either way — **the entire session is revoked**, including the current
valid token. Both the thief and the victim are forced to re-authenticate.
The event is logged and audited as `REFRESH_TOKEN_REUSE_DETECTED`.

Rotated tokens inherit the session's `expiresAt` rather than extending it.
The session lifetime is an **absolute cap**: refreshing keeps a session alive
within its window but cannot extend it indefinitely.

## Sessions

One row per device login, carrying user agent, IP, and expiry. Refresh tokens
hang off a session, so revoking the session revokes the whole rotation chain
in one transaction.

- `GET /auth/sessions` — list, with the caller's own flagged `current`.
- `DELETE /auth/sessions/:id` — revoke one. Ownership is enforced in the
  service; another user's session is reported **404, not 403**, so ids cannot
  be probed for existence.
- `DELETE /auth/sessions` — revoke every session except the caller's.

Password **reset** revokes every session (the user believes they are
compromised). Password **change** revokes every session _except_ the caller's
(they should not be logged out of the tab they are working in).

## Password hashing

Argon2id via `@node-rs/argon2`, at OWASP's 19 MiB / t=2 / p=1 profile, pinned
explicitly so a dependency upgrade cannot silently change the cost of every
stored hash.

`@node-rs/argon2` rather than `argon2` or `bcrypt` for a concrete reason: both
Dockerfile stages run `npm ci --ignore-scripts`, so a node-gyp module would
never compile in the image. `@node-rs/argon2` ships prebuilt NAPI binaries
(including `linux-x64-musl` for the Alpine base) and needs no install script.

**Timing.** The unknown-email branch of login verifies the submitted password
against a dummy hash generated at startup with the same parameters. Without
it, "no such user" would return measurably faster than "wrong password", and
response time alone would enumerate valid addresses.

## Verification and reset tokens

Both are opaque tokens stored as keyed hashes, with an expiry
(`EMAIL_VERIFICATION_EXPIRES`, default 24h; `PASSWORD_RESET_EXPIRES`, default
1h) and a `usedAt` marker.

Single use is enforced **atomically**, with a conditional `updateMany` that
only lands while `usedAt IS NULL`, and a check on the affected row count. Two
concurrent requests cannot both observe an unused token and proceed.

Issuing a new token invalidates outstanding ones for that user, so a link from
an earlier email cannot be replayed.

## Two-factor authentication

TOTP (RFC 6238), 160-bit secrets, ±30s tolerance for clock skew.

1. `POST /auth/2fa/setup` — generates a secret, stores it **encrypted**, and
   returns it plus an `otpauth://` URI. This response is the only time the
   secret is ever readable; the user has to transfer it to an app.
2. `POST /auth/2fa/confirm` — proves the app was set up correctly before 2FA
   goes live, so an abandoned enrollment cannot lock anyone out. Returns ten
   single-use backup codes, shown once.
3. `POST /auth/2fa/disable` — **requires the account password**, not just a
   session. An attacker with a borrowed unlocked browser must not be able to
   strip the second factor.

**Storage.** Secrets are encrypted at rest with AES-256-GCM under a key
derived from `TWO_FACTOR_SECRET_KEY` (required, no default — a shipped
encryption key protects nothing). The payload is versioned (`v1.iv.tag.data`)
so a future key rotation can still read old rows. GCM's auth tag means a
tampered ciphertext fails loudly instead of decrypting to garbage.

Backup codes are stored as keyed hashes, never in plaintext. They are ~49 bits
of entropy each, which is why a fast keyed hash is appropriate rather than
Argon2 — verification compares against all ten stored digests, and ten Argon2
verifications per attempt would take ~500ms. Redemption uses a conditional
`updateMany`, so the same code cannot be spent twice concurrently.

**Login challenge.** When 2FA is enabled, a correct password issues _no
tokens_. Instead a short-lived challenge (default 5 minutes) is stored in
Redis — not Postgres, because a table of password-verified-but-unfinished
logins is state that would only need pruning. The challenge token is returned
in the body _and_ set as an httpOnly cookie, so `POST /auth/2fa/challenge`
works both for native clients that hold state and for the shipped `/2fa` page,
which holds none.

## RBAC

Six roles, matching the frontend's `UserRole` union exactly:
`guest`, `member`, `verified_builder`, `moderator`, `community_admin`,
`platform_admin`.

BACKEND_TRD.md §14 lists a different four (`USER`/`MODERATOR`/`ADMIN`/
`SUPER_ADMIN`). The frontend's set wins, as it did in Phase 2: `AppSidebar`
and `AdminGuard` already gate on these six through `src/lib/rbac.ts`, and
adopting the doc's would break shipped authorization code.

`requireAdmin` mirrors the frontend's `isAdminRole` exactly — moderator,
community admin, platform admin. Keeping them in step matters in both
directions: a server that allowed a role the sidebar hides would show users
links that 403, and the reverse would be a privilege gap.

**`guest` is never persisted.** It is the frontend's sentinel for "not signed
in". `createUser` always writes `member`, and `isAuthorizedRole` refuses
`guest` unconditionally.

Ownership checks are a plain assertion (`assertOwnershipOrAdmin`) rather than
middleware, because ownership usually cannot be decided from the request
alone — the service has to load the resource first. Admins bypass, which is
the point of having them.

## Brute-force protection

Two independent mechanisms, deliberately not merged:

|          | Rate limiter                             | Brute-force lockout                          |
| -------- | ---------------------------------------- | -------------------------------------------- |
| Counts   | requests                                 | failures                                     |
| Keyed on | source address                           | identifier (email / user id)                 |
| Stops    | one host hammering an endpoint           | credential stuffing spread across many hosts |
| Lives in | `rate-limit.middleware.ts` (Redis store) | `utils/brute-force.ts` (Redis counters)      |

A botnet spreading guesses defeats a per-IP limit but not a per-account one; a
single host attacking many accounts defeats a per-account limit but not a
per-IP one. Both are needed.

Lockout is progressive: with `AUTH_BRUTE_FORCE_MAX_ATTEMPTS=5`, failures 1–4
are free, the 5th applies a 60s lock, the 6th 120s, doubling up to
`AUTH_BRUTE_FORCE_MAX_LOCK_SECONDS`. Scopes: `login`, `register`,
`password-reset`, `email-verification`, `two-factor`.

State lives in Redis rather than Postgres. No `failedLoginAttempts` column
exists, adding one would need a migration, and short-lived counters are what
BACKEND_ARCHITECTURE.md §19 nominates Redis for anyway.

Identifiers are **hashed before becoming Redis keys**, so a cache dump does
not reveal which accounts are under attack.

Both mechanisms **fail open** if Redis is unreachable, consistent with the
rate limiter's existing `passOnStoreError`: losing the cache should degrade a
defense, not lock every user out of the product.

## User enumeration

The whole surface is built so that responses do not disclose which addresses
have accounts.

| Endpoint                         | Behavior                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /auth/login`               | One message, `"Invalid email or password"`, for unknown email and wrong password alike — and the unknown branch pays the same Argon2 cost. |
| `POST /auth/register`            | **Identical 201 whether or not the email is taken.** No second account is created; the existing owner is emailed instead.                  |
| `POST /auth/password/forgot`     | Always 200.                                                                                                                                |
| `POST /auth/verify-email/resend` | Always 200, including for already-verified addresses.                                                                                      |
| `DELETE /auth/sessions/:id`      | 404 rather than 403 for someone else's session.                                                                                            |
| Lockout                          | Identical message for a locked real account and a locked fictional one.                                                                    |

Account status is checked **after** the password verifies. At that point the
caller has already proved they own the account, so `"This account has been
suspended"` reveals nothing they did not know — and a generic message would
just be unhelpful.

### `POST /auth/register` — exact contract for a duplicate email

This is the one place the no-enumeration rule trades a familiar UX for
privacy, so the current behaviour is specified here in full. **Verified
against the running build, not just asserted in tests.**

Given a request whose `email` already belongs to an account:

|                         | New email                                                                                                                                              | Already-registered email                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| HTTP status             | `201 Created`                                                                                                                                          | `201 Created`                                                                |
| Response body           | `{"success":true,"data":{"email":"<submitted>","verificationRequired":true},"message":"Account created — check your email to verify it","error":null}` | **byte-identical**                                                           |
| Response headers        | no `Set-Cookie`                                                                                                                                        | no `Set-Cookie`                                                              |
| Rows written to `users` | 1                                                                                                                                                      | **0**                                                                        |
| Existing row mutated?   | n/a                                                                                                                                                    | **no** — displayName, password, and role are all left untouched              |
| Email dispatched        | verification link                                                                                                                                      | security alert: "an attempt to create a new account with your email address" |
| Audit entries           | `USER_REGISTERED`, `TERMS_ACCEPTED`                                                                                                                    | none                                                                         |
| Brute-force counter     | untouched                                                                                                                                              | `register` scope incremented, keyed on **source IP**                         |

Consequences a client must be aware of:

- **A 201 is not proof an account was created.** It means "the request was
  accepted and, if this address was free, an account now exists."
- **Registration is not a way to change a password.** Re-registering an
  existing address does not overwrite anything.
- The endpoint therefore cannot be used to test whether an address is
  registered, which is the entire point.
- The `register` lockout is keyed on the requesting IP rather than the
  submitted email — keying it on the email would let an attacker permanently
  block a specific address from ever registering.

The shipped signup form navigates to `/verify-email` on success either way, so
nothing in the current frontend distinguishes the two cases.

**If this is ever revisited**, returning `409 CONFLICT` instead is a single
branch in `auth.service.register` (the `if (existing)` block) plus its
OpenAPI response and the two tests that assert byte-identical bodies. Nothing
else depends on it. Doing so reintroduces the enumeration oracle by design.

## Audit logging

Security-sensitive actions are written to `audit_logs` via
`utils/audit.ts` → `repositories/audit.repository.ts`. Actions:

`USER_REGISTERED`, `TERMS_ACCEPTED`, `USER_LOGIN`, `USER_LOGIN_FAILED`,
`ACCOUNT_LOCKED`, `USER_LOGOUT`, `EMAIL_VERIFICATION_SENT`, `EMAIL_VERIFIED`,
`PASSWORD_CHANGED`, `PASSWORD_RESET_REQUESTED`, `PASSWORD_RESET_COMPLETED`,
`TOKEN_REFRESHED`, `REFRESH_TOKEN_REUSE_DETECTED`, `SESSION_REVOKED`,
`ALL_SESSIONS_REVOKED`, `TWO_FACTOR_ENROLLMENT_STARTED`,
`TWO_FACTOR_ENABLED`, `TWO_FACTOR_DISABLED`, `TWO_FACTOR_CHALLENGE_FAILED`,
`TWO_FACTOR_BACKUP_CODE_USED`.

Writes never throw: a failed audit insert is logged loudly and swallowed.
Losing one row is bad; failing a successful login because the audit write
timed out is worse.

`TERMS_ACCEPTED` is here because the signup form's `agreeToTerms` has no
column on `users` and adding one would need a migration. An append-only record
is arguably the better home for a legal attestation anyway.

Metadata never contains credentials.

## Email

`EmailService` depends on an `EmailProvider` interface, never a concrete
transport (TRD §26). Only `ConsoleEmailProvider` exists so far; adding a real
provider is one case in `integrations/email/index.ts` and one value in the
`EMAIL_PROVIDER` enum.

The console provider writes to `process.stdout` directly rather than through
Pino. Verification and reset links contain single-use tokens, and TRD §30
forbids those from entering the log stream that ships to an aggregator — so
the local developer experience (click the link) is preserved without ever
putting a token into structured logs. In production it refuses to emit and
logs an error instead.

Delivery failures are logged and swallowed. A mail outage must not fail a
registration that already committed, and must never be observable in a way
that reveals whether an address exists.

## Log redaction

Pino redacts every credential-bearing field: passwords, hashes, tokens of all
kinds, TOTP secrets, backup codes, plus `Authorization` and `Cookie` headers.

Both bare (`password`) and wildcard (`*.password`) forms are listed. Pino's
`*` matches exactly one intermediate level, so the wildcard alone covers
`{ body: { password } }` but **not** a top-level `logger.info({ password })` —
which is the shape service code is most likely to produce by accident. The
Phase 1 list had only the wildcard forms; this was found by the test that now
guards it.

## Socket authentication

Every Socket.IO connection is authenticated at the handshake, before any
handler runs (TRD §20). The token comes from `handshake.auth.token` or an
`Authorization` header, is verified exactly as the REST API verifies it, and
the user is re-read from the database.

A `userId` in the handshake payload is **ignored entirely** — it is
attacker-controlled. The `user:{id}` room a socket joins is derived from the
verified identity, which is what stops a socket subscribing to someone else's
events.

Rejections carry `err.data.code` so a client can tell "refresh and retry"
apart from "sign in again".

## Endpoints

| Method | Path                               | Auth            |
| ------ | ---------------------------------- | --------------- |
| POST   | `/api/v1/auth/register`            | —               |
| POST   | `/api/v1/auth/login`               | —               |
| POST   | `/api/v1/auth/refresh`             | refresh cookie  |
| POST   | `/api/v1/auth/logout`              | optional        |
| GET    | `/api/v1/auth/me`                  | bearer          |
| POST   | `/api/v1/auth/verify-email`        | —               |
| POST   | `/api/v1/auth/verify-email/resend` | —               |
| POST   | `/api/v1/auth/password/forgot`     | —               |
| POST   | `/api/v1/auth/password/reset`      | —               |
| POST   | `/api/v1/auth/password/change`     | bearer          |
| GET    | `/api/v1/auth/sessions`            | bearer          |
| DELETE | `/api/v1/auth/sessions`            | bearer          |
| DELETE | `/api/v1/auth/sessions/:id`        | bearer          |
| POST   | `/api/v1/auth/2fa/setup`           | bearer          |
| POST   | `/api/v1/auth/2fa/confirm`         | bearer          |
| POST   | `/api/v1/auth/2fa/disable`         | bearer          |
| POST   | `/api/v1/auth/2fa/challenge`       | challenge token |

All are documented in the OpenAPI document at `/api/v1/openapi.json`.

## Username generation

The shipped signup form collects displayName, email, and password — no
username — yet `users.username` is `NOT NULL UNIQUE` and profile routes are
`/profile/[username]`. So the server generates one.

Derived from **displayName only**, never the email: an email local part
frequently contains a real name or an internal identifier the user did not
choose to publish. Folded into the frontend's own character set
(`/^[a-z0-9._]+$/i`, min 3) so the result is something the user could have
typed and can later edit without the account form rejecting it. Accents are
decomposed and stripped rather than dropped whole, so "Renée Ó Súilleabháin"
becomes `renee.o.suilleabhain`.

Collisions take the lowest free numeric suffix (`ava.whitfield2`). That lookup
is **not** what guarantees uniqueness — two simultaneous registrations can
compute the same candidate. The unique index is the guarantee: registration
catches `P2002` on `username`, picks a random suffix, and retries. `P2002` on
`email` is a genuine duplicate and takes the no-enumeration path above.

## What Phase 3 deliberately does not do

- **No OAuth.** PRD §4 asks for an OAuth-_ready_ architecture, which the
  session/token split provides — an OAuth callback would create a session
  exactly as password login does. The Google/GitHub buttons remain inert.
- **No frontend wiring.** Every `src/lib/services/*` module is still a mock.
  Two flows have no page to land on yet: `/verify-email` reads only `?email=`,
  and there is no `/reset-password` route at all. Both endpoints ship and are
  tested; the pages are a frontend-integration task.
- **No full user profile.** `/auth/me` returns the identity subset the shell
  needs. Achievements, badges, counters, and reputation belong to the
  users/profiles module in Phase 4.
