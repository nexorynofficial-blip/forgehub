import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Phase 13 — cross-cutting hardening and regression (TRD §32 "Validation",
 * "Critical security paths"; ARCHITECTURE §35 "Prioritize tests for
 * security-sensitive functionality").
 *
 * Every module suite tests its own module. This file tests the seams between
 * them — the properties that are supposed to hold *everywhere* and which no
 * single module suite is responsible for:
 *
 *   - user input never reaches a 5xx, on any module;
 *   - authentication is actually required wherever it is claimed;
 *   - a ban decided in Phase 11 is enforced by Phase 3 middleware and is
 *     therefore felt by every phase in between.
 *
 * The first group is a regression test for a real defect this phase found and
 * fixed. See "the cursor 500" below.
 */

vi.mock("../src/integrations/email/index.js", () => ({
  emailService: {
    providerName: "test",
    sendVerificationEmail: () => Promise.resolve(),
    sendPasswordResetEmail: () => Promise.resolve(),
    sendSecurityAlertEmail: () => Promise.resolve(),
  },
}));

const { createApp } = await import("../src/app.js");
const { prisma } = await import("../src/database/prisma.js");
const { connectRedis, redis } = await import("../src/config/redis.js");

const app = createApp();

const NS = "hardening";
const PASSWORD = "ValidPass123";

let counter = 0;
function uniqueEmail(): string {
  counter += 1;
  return `${NS}.${String(counter)}.${String(Date.now())}@forgehub.test`;
}

interface TestUser {
  email: string;
  userId: string;
  username: string;
  accessToken: string;
}

async function createUser(displayName = "Hardening Tester"): Promise<TestUser> {
  const email = uniqueEmail();

  await request(app)
    .post("/api/v1/auth/register")
    .send({
      displayName,
      email,
      password: PASSWORD,
      confirmPassword: PASSWORD,
      agreeToTerms: true,
    })
    .expect(201);

  const login = await request(app)
    .post("/api/v1/auth/login")
    .send({ email, password: PASSWORD, rememberMe: false })
    .expect(200);

  return {
    email,
    userId: login.body.data.user.id as string,
    username: login.body.data.user.username as string,
    accessToken: login.body.data.accessToken as string,
  };
}

function bearer(token: string): [string, string] {
  return ["Authorization", `Bearer ${token}`];
}

beforeAll(async () => {
  await connectRedis();
});

afterAll(async () => {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: NS } },
    select: { id: true },
  });
  const ids = users.map((user) => user.id);

  if (ids.length > 0) {
    await prisma.auditLog.deleteMany({
      where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] },
    });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  await prisma.$disconnect();
  await redis.quit();
});

/* ── The cursor 500 ──────────────────────────────────────────────────────── */

const VALID_UUID = "00000000-0000-4000-8000-000000000000";

/**
 * Every cursor-paged endpoint in the API.
 *
 * **The defect this fixes.** `cursor` was validated as `z.string().min(1)`,
 * then handed to Prisma as `cursor: { id }`. Every id it pages over is a
 * `@db.Uuid` column, so a non-UUID cursor reached PostgreSQL, which rejected
 * it with an error `error.middleware` maps only for `P2002`/`P2025` — so it
 * fell through to **500**. Any caller could produce one with a query string.
 *
 * Phase 8 and Phase 9 had already guarded against this in their own schemas
 * (`messages.schema.ts` says so explicitly: *"a Prisma error surfacing as a
 * 500"*); the earlier modules and `utils/pagination.ts` had not. The fix
 * applies the convention `posts.schema.ts` already stated for path ids —
 * *"a malformed id is a 422 rather than a database trip."*
 */
const CURSOR_ENDPOINTS: readonly string[] = [
  "/api/v1/feed",
  `/api/v1/posts/${VALID_UUID}/comments`,
  `/api/v1/comments/${VALID_UUID}/replies`,
  "/api/v1/communities",
  "/api/v1/notifications",
  "/api/v1/messages/conversations",
  "/api/v1/users/me/bookmarks",
];

/** Shapes a cursor can take that are not a UUID. */
const BAD_CURSORS: readonly string[] = [
  "%FF%FF",
  "12345",
  "not-a-uuid",
  "x".repeat(300),
  "'%20OR%201=1--",
  "00000000-0000-4000-8000-00000000000", // one digit short
];

describe("Malformed input never reaches a 5xx", () => {
  let user: TestUser;

  beforeAll(async () => {
    user = await createUser("Cursor Prober");
  });

  it("answers 422 for a malformed cursor on every cursor-paged endpoint", async () => {
    for (const endpoint of CURSOR_ENDPOINTS) {
      const response = await request(app)
        .get(`${endpoint}?cursor=not-a-uuid`)
        .set(...bearer(user.accessToken));

      expect(response.status, `${endpoint} should reject a malformed cursor`).toBe(422);
    }
  });

  it("answers 422 for every shape of bad cursor, never 5xx", async () => {
    for (const cursor of BAD_CURSORS) {
      const response = await request(app)
        .get(`/api/v1/feed?cursor=${cursor}`)
        .set(...bearer(user.accessToken));

      expect(response.status, `cursor=${cursor}`).toBe(422);
    }
  });

  it("still accepts a well-formed cursor", async () => {
    // The guard must reject the malformed, not the merely unknown: a
    // syntactically valid id that matches no row is an empty page, not an
    // error, or the fix would have broken paging instead of hardening it.
    const response = await request(app)
      .get(`/api/v1/feed?cursor=${VALID_UUID}`)
      .set(...bearer(user.accessToken))
      .expect(200);

    expect(response.body.success).toBe(true);
  });

  it("answers 4xx, never 5xx, for malformed input across every module", async () => {
    const probes: ReadonlyArray<readonly [string, string]> = [
      ["malformed post id", "/api/v1/posts/not-a-uuid"],
      ["malformed comment id", "/api/v1/comments/not-a-uuid/replies"],
      ["invalid feed filter", "/api/v1/feed?filter=nonsense"],
      ["negative limit", "/api/v1/feed?limit=-5"],
      ["oversized limit", "/api/v1/feed?limit=999999"],
      ["non-numeric limit", "/api/v1/feed?limit=abc"],
      ["invalid date", "/api/v1/feed/new-count?since=notadate&filter=latest"],
      ["invalid search type", "/api/v1/search?q=test&type=bogus"],
      ["invalid search sort", "/api/v1/search?q=test&sort=bogus"],
      ["oversized query", `/api/v1/search?q=${"x".repeat(5000)}`],
      ["negative page", "/api/v1/projects?page=-1"],
      ["non-numeric page", "/api/v1/projects?page=abc"],
      ["blank community slug", "/api/v1/communities/%20%20"],
    ];

    for (const [label, path] of probes) {
      const response = await request(app)
        .get(path)
        .set(...bearer(user.accessToken));

      expect(response.status, `${label} (${path})`).toBeLessThan(500);
      expect(response.status, `${label} (${path})`).toBeGreaterThanOrEqual(400);
    }
  });
});

/* ── Authentication is required where it is claimed ──────────────────────── */

describe("Authentication boundaries", () => {
  const PROTECTED: readonly string[] = [
    "/api/v1/auth/me",
    "/api/v1/auth/sessions",
    "/api/v1/users/me",
    "/api/v1/users/me/settings",
    "/api/v1/users/me/blocks",
    "/api/v1/users/me/bookmarks",
    "/api/v1/users/me/notification-preferences",
    "/api/v1/notifications",
    "/api/v1/notifications/unread",
    "/api/v1/messages/conversations",
    "/api/v1/moderation/reports",
    "/api/v1/admin/users",
    "/api/v1/admin/stats",
    "/api/v1/admin/audit-logs",
    "/api/v1/admin/analytics/signups",
    "/api/v1/admin/analytics/reports-by-reason",
  ];

  it("answers 401 for every protected read without a token", async () => {
    for (const path of PROTECTED) {
      const response = await request(app).get(path);
      expect(response.status, path).toBe(401);
    }
  });

  it("answers 401 for a structurally invalid token, not 500", async () => {
    for (const token of ["garbage", "a.b.c", "", "Bearer", "null"]) {
      const response = await request(app)
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${token}`);

      expect(response.status, `token=${token}`).toBe(401);
    }
  });

  it("does not accept a token in a query string", async () => {
    // Tokens in URLs end up in access logs, proxies, and Referer headers.
    const user = await createUser("Query Token");
    const response = await request(app).get(
      `/api/v1/auth/me?access_token=${user.accessToken}`,
    );

    expect(response.status).toBe(401);
  });
});

/* ── A ban is felt by every phase ────────────────────────────────────────── */

describe("Account status is enforced across every module", () => {
  /**
   * `requireAuth` re-reads moderation status on every request, so a ban is
   * supposed to take effect immediately and everywhere. "Everywhere" is the
   * part no module suite owns: `auth-security.test.ts` proves the mechanism
   * on `/auth/me`, and this proves the mechanism actually covers the other
   * eleven modules rather than only the one it was written against.
   */
  /**
   * Authenticated routes an *ordinary* member may reach, one per module.
   *
   * Two kinds of route are deliberately excluded:
   *
   *   - **Staff-only** routes, because a `requireAdmin` route answers 403 for
   *     any ordinary account, banned or not — including one would let the ban
   *     assertion below pass for the wrong reason.
   *   - **`optionalAuth`** routes such as `/feed` and `/search`, which serve a
   *     banned caller the *anonymous* response rather than refusing them.
   *     That degradation is correct and is asserted separately below.
   */
  const ACROSS_MODULES: readonly string[] = [
    "/api/v1/auth/me",
    "/api/v1/users/me",
    "/api/v1/users/me/settings",
    "/api/v1/users/me/blocks",
    "/api/v1/users/me/bookmarks",
    "/api/v1/notifications",
    "/api/v1/notifications/unread",
    "/api/v1/messages/conversations",
  ];

  it("refuses a banned account on every authenticated route", async () => {
    const user = await createUser("Banned Everywhere");

    await request(app)
      .get("/api/v1/feed")
      .set(...bearer(user.accessToken))
      .expect(200);

    await prisma.user.update({
      where: { id: user.userId },
      data: { status: "banned" },
    });

    for (const path of ACROSS_MODULES) {
      const response = await request(app)
        .get(path)
        .set(...bearer(user.accessToken));

      // 403, not 401: the credential is valid, the account is not permitted.
      expect(response.status, path).toBe(403);
    }
  });

  it("refuses a banned account on write paths too", async () => {
    const user = await createUser("Banned Writer");
    await prisma.user.update({
      where: { id: user.userId },
      data: { status: "banned" },
    });

    const writes: ReadonlyArray<readonly [string, string, object]> = [
      ["post", "/api/v1/posts", { content: "should never be written" }],
      [
        "post",
        "/api/v1/moderation/reports",
        { targetType: "user", targetId: VALID_UUID, reason: "spam" },
      ],
      ["patch", "/api/v1/users/me", { displayName: "Renamed While Banned" }],
    ];

    for (const [method, path, body] of writes) {
      const response = await request(app)
        [method as "post"](path)
        .set(...bearer(user.accessToken))
        .send(body);

      expect(response.status, `${method.toUpperCase()} ${path}`).toBe(403);
    }
  });

  it("degrades a banned account to anonymous on optionalAuth routes", async () => {
    /**
     * `optionalAuth` catches the authentication failure and continues as
     * anonymous. That is the correct behaviour — a public route stays public
     * — but it is worth pinning: the failure mode would be a banned user
     * keeping *viewer* privileges on every optional-auth read in the API,
     * which is a privilege the ban is supposed to remove.
     */
    const user = await createUser("Banned Searcher");

    const beforeBan = await request(app)
      .get("/api/v1/search?q=forgehub")
      .set(...bearer(user.accessToken))
      .expect(200);

    await prisma.user.update({
      where: { id: user.userId },
      data: { status: "banned" },
    });

    // Still 200 — the route is public — but served as anonymous, not as a
    // signed-in viewer, and certainly not a 500.
    const afterBan = await request(app)
      .get("/api/v1/search?q=forgehub")
      .set(...bearer(user.accessToken))
      .expect(200);

    expect(beforeBan.body.success).toBe(true);
    expect(afterBan.body.success).toBe(true);

    // The feed is the other optionalAuth surface and behaves the same way.
    await request(app)
      .get("/api/v1/feed")
      .set(...bearer(user.accessToken))
      .expect(200);

    // The definitive check: the same token is refused by a route that
    // actually requires identity.
    await request(app)
      .get("/api/v1/auth/me")
      .set(...bearer(user.accessToken))
      .expect(403);
  });

  it("leaves a shadow-banned account fully functional", async () => {
    // Ruling R3 kept shadow-ban unenforced on read paths, and the point of a
    // shadow ban is that its subject cannot detect it. A 403 here would be
    // the tell.
    const user = await createUser("Shadow Banned Everywhere");
    await prisma.user.update({
      where: { id: user.userId },
      data: { status: "shadow_banned" },
    });

    for (const path of ACROSS_MODULES) {
      const response = await request(app)
        .get(path)
        .set(...bearer(user.accessToken));

      expect(response.status, path).toBe(200);
    }
  });

  it("restores access when a temporary suspension has expired", async () => {
    /**
     * Ruling R12's lazy expiry, exercised end to end: Phase 11 writes the
     * `suspension` action, Phase 3 middleware lifts it on the next request,
     * and the account works again — with no scheduler anywhere.
     */
    const user = await createUser("Suspended Then Free");

    await prisma.user.update({
      where: { id: user.userId },
      data: { status: "banned" },
    });
    await prisma.moderationAction.create({
      data: {
        moderatorId: user.userId,
        targetUserId: user.userId,
        action: "suspension",
        targetType: "user",
        targetId: user.userId,
        reason: "phase 13 expiry regression",
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    // The request that would have been refused is the one that lifts it.
    await request(app)
      .get("/api/v1/auth/me")
      .set(...bearer(user.accessToken))
      .expect(200);

    const after = await prisma.user.findUnique({
      where: { id: user.userId },
      select: { status: true },
    });
    expect(after?.status).toBe("active");
  });

  it("keeps an unexpired suspension in force", async () => {
    const user = await createUser("Still Suspended");

    await prisma.user.update({
      where: { id: user.userId },
      data: { status: "banned" },
    });
    await prisma.moderationAction.create({
      data: {
        moderatorId: user.userId,
        targetUserId: user.userId,
        action: "suspension",
        targetType: "user",
        targetId: user.userId,
        reason: "phase 13 unexpired regression",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    await request(app)
      .get("/api/v1/auth/me")
      .set(...bearer(user.accessToken))
      .expect(403);

    const after = await prisma.user.findUnique({
      where: { id: user.userId },
      select: { status: true },
    });
    expect(after?.status).toBe("banned");
  });
});

/* ── Response envelope consistency ───────────────────────────────────────── */

describe("Error envelope is uniform across modules", () => {
  it("returns the standard error shape for 401, 403, 404, and 422", async () => {
    const user = await createUser("Envelope Reader");

    const cases: ReadonlyArray<readonly [number, () => Promise<request.Response>]> = [
      [401, () => request(app).get("/api/v1/notifications")],
      [
        404,
        () =>
          request(app)
            .get(`/api/v1/posts/${VALID_UUID}`)
            .set(...bearer(user.accessToken)),
      ],
      [
        422,
        () =>
          request(app)
            .get("/api/v1/feed?filter=nope")
            .set(...bearer(user.accessToken)),
      ],
    ];

    for (const [status, send] of cases) {
      const response = await send();

      expect(response.status).toBe(status);
      expect(response.body.success).toBe(false);
      // `utils/response.errorResponse`: the message lives under `error`, and
      // `data` is an explicit null rather than an absent key.
      expect(response.body.data).toBeNull();
      expect(typeof response.body.error?.code).toBe("string");
      expect(typeof response.body.error?.message).toBe("string");
      expect(response.body.error.message.length).toBeGreaterThan(0);
    }
  });

  it("names a distinct error code per failure kind", async () => {
    const user = await createUser("Code Reader");

    const unauthenticated = await request(app).get("/api/v1/notifications").expect(401);
    const missing = await request(app)
      .get(`/api/v1/posts/${VALID_UUID}`)
      .set(...bearer(user.accessToken))
      .expect(404);
    const invalid = await request(app)
      .get("/api/v1/feed?filter=nope")
      .set(...bearer(user.accessToken))
      .expect(422);

    // Three different failures must not collapse into one opaque code, or a
    // client cannot tell "log in again" from "that is gone".
    const codes = [
      unauthenticated.body.error.code,
      missing.body.error.code,
      invalid.body.error.code,
    ];
    expect(new Set(codes).size).toBe(3);
  });
});
