import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The administration surface end to end (PRD §18, TRD §29, ARCHITECTURE §26).
 *
 * PRD §18 lists seven administrator capabilities; four of them have endpoints
 * in this phase — user management, reports (as counts), analytics, and audit
 * logs. This file walks each for callers who are allowed to use it.
 * Authorization refusals live in `admin-security.test.ts`.
 *
 * Response shapes are checked against the *shipped frontend contract*
 * (`src/lib/services/admin-service.ts`), because the frontend is frozen and
 * the backend is what has to fit.
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

const NS = "adminflow";
const PASSWORD = "ValidPass123";
const BASE = "/api/v1/admin";

let counter = 0;
function uniqueEmail(): string {
  counter += 1;
  return `${NS}.${String(counter)}.${String(Date.now())}@forgehub.test`;
}

interface TestUser {
  userId: string;
  username: string;
  token: string;
}

async function createUser(): Promise<TestUser> {
  const email = uniqueEmail();

  await request(app)
    .post("/api/v1/auth/register")
    .send({
      displayName: "Admin Tester",
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
    userId: login.body.data.user.id as string,
    username: login.body.data.user.username as string,
    token: login.body.data.accessToken as string,
  };
}

type Role = "moderator" | "community_admin" | "platform_admin";

async function userWithRole(role: Role): Promise<TestUser> {
  const user = await createUser();
  await prisma.user.update({ where: { id: user.userId }, data: { role } });
  return user;
}

function bearer(token: string): [string, string] {
  return ["Authorization", `Bearer ${token}`];
}

beforeAll(async () => {
  await connectRedis();
}, 60_000);

afterAll(async () => {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: NS } },
    select: { id: true },
  });
  const ids = users.map((user) => user.id);

  if (ids.length > 0) {
    await prisma.moderationAction.deleteMany({
      where: { OR: [{ moderatorId: { in: ids } }, { targetUserId: { in: ids } }] },
    });
    await prisma.report.deleteMany({
      where: { OR: [{ reporterId: { in: ids } }, { targetAuthorId: { in: ids } }] },
    });
    await prisma.notification.deleteMany({
      where: { OR: [{ userId: { in: ids } }, { actorId: { in: ids } }] },
    });
    await prisma.auditLog.deleteMany({
      where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] },
    });
    await prisma.post.deleteMany({ where: { authorId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  await prisma.$disconnect();
  await redis.quit();
});

/* ── User management ─────────────────────────────────────────────────────── */

describe("GET /admin/users", () => {
  it("returns the shape the shipped AdminUserSummary expects", async () => {
    const admin = await userWithRole("platform_admin");
    await createUser();

    const response = await request(app)
      .get(`${BASE}/users`)
      .set(...bearer(admin.token))
      .expect(200);

    expect(response.body.pagination).toMatchObject({ page: 1, limit: 20 });

    const row = response.body.data[0];
    expect(Object.keys(row).sort()).toEqual([
      "followersCount",
      "joinedAt",
      "projectsCount",
      "role",
      "status",
      "user",
    ]);
    expect(Object.keys(row.user).sort()).toEqual([
      "avatarUrl",
      "builderRank",
      "displayName",
      "id",
      "username",
    ]);
  });

  it("never serves an email address", async () => {
    const admin = await userWithRole("platform_admin");
    await createUser();

    const response = await request(app)
      .get(`${BASE}/users`)
      .query({ limit: 100 })
      .set(...bearer(admin.token))
      .expect(200);

    expect(JSON.stringify(response.body)).not.toContain("@forgehub.test");
    expect(JSON.stringify(response.body)).not.toContain("passwordHash");
  });

  it("orders newest account first", async () => {
    const admin = await userWithRole("platform_admin");
    await createUser();
    await createUser();

    const response = await request(app)
      .get(`${BASE}/users`)
      .query({ limit: 50 })
      .set(...bearer(admin.token))
      .expect(200);

    const times = response.body.data.map((row: { joinedAt: string }) =>
      new Date(row.joinedAt).getTime(),
    );
    expect(times).toEqual([...times].sort((a: number, b: number) => b - a));
  });

  it("filters by role and by status", async () => {
    const admin = await userWithRole("platform_admin");
    await userWithRole("moderator");

    const byRole = await request(app)
      .get(`${BASE}/users`)
      .query({ role: "moderator", limit: 100 })
      .set(...bearer(admin.token))
      .expect(200);

    for (const row of byRole.body.data) expect(row.role).toBe("moderator");

    const byStatus = await request(app)
      .get(`${BASE}/users`)
      .query({ status: "active", limit: 100 })
      .set(...bearer(admin.token))
      .expect(200);

    for (const row of byStatus.body.data) expect(row.status).toBe("active");
  });

  it("422s an unknown role filter and a non-positive page", async () => {
    const admin = await userWithRole("platform_admin");

    await request(app)
      .get(`${BASE}/users`)
      .query({ role: "overlord" })
      .set(...bearer(admin.token))
      .expect(422);

    await request(app)
      .get(`${BASE}/users`)
      .query({ page: 0 })
      .set(...bearer(admin.token))
      .expect(422);
  });

  it("422s a limit above the maximum page size", async () => {
    const admin = await userWithRole("platform_admin");

    await request(app)
      .get(`${BASE}/users`)
      .query({ limit: 500 })
      .set(...bearer(admin.token))
      .expect(422);
  });
});

/* ── Role changes ────────────────────────────────────────────────────────── */

describe("PATCH /admin/users/:id/role", () => {
  it("promotes a member and audits it as ROLE_CHANGED", async () => {
    const admin = await userWithRole("platform_admin");
    const target = await createUser();

    const response = await request(app)
      .patch(`${BASE}/users/${target.userId}/role`)
      .set(...bearer(admin.token))
      .send({ role: "moderator" })
      .expect(200);

    expect(response.body.data.user.role).toBe("moderator");

    const stored = await prisma.user.findUnique({ where: { id: target.userId } });
    expect(stored?.role).toBe("moderator");

    const audit = await prisma.auditLog.findFirst({
      where: { action: "ROLE_CHANGED", targetId: target.userId },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorId).toBe(admin.userId);
    expect(audit?.metadata).toMatchObject({ from: "member", to: "moderator" });
  });

  it("409s assigning the role the account already holds", async () => {
    const admin = await userWithRole("platform_admin");
    const target = await userWithRole("moderator");

    await request(app)
      .patch(`${BASE}/users/${target.userId}/role`)
      .set(...bearer(admin.token))
      .send({ role: "moderator" })
      .expect(409);
  });

  it("404s a user that does not exist", async () => {
    const admin = await userWithRole("platform_admin");

    await request(app)
      .patch(`${BASE}/users/00000000-0000-4000-8000-000000000000/role`)
      .set(...bearer(admin.token))
      .send({ role: "moderator" })
      .expect(404);
  });

  it("422s an unknown role and a malformed id", async () => {
    const admin = await userWithRole("platform_admin");
    const target = await createUser();

    await request(app)
      .patch(`${BASE}/users/${target.userId}/role`)
      .set(...bearer(admin.token))
      .send({ role: "overlord" })
      .expect(422);

    await request(app)
      .patch(`${BASE}/users/not-a-uuid/role`)
      .set(...bearer(admin.token))
      .send({ role: "moderator" })
      .expect(422);
  });
});

/* ── Status changes ──────────────────────────────────────────────────────── */

describe("PATCH /admin/users/:id/status", () => {
  it("bans through the same transactional path moderation uses", async () => {
    const admin = await userWithRole("platform_admin");
    const target = await createUser();

    const response = await request(app)
      .patch(`${BASE}/users/${target.userId}/status`)
      .set(...bearer(admin.token))
      .send({ status: "banned", reason: "Admin table." })
      .expect(200);

    expect(response.body.data.action.action).toBe("ban");
    expect(response.body.data.statusChanged).toBe(true);

    // The delegation is the point: an admin-table ban produces a
    // ModerationAction and an AuditLog, exactly as POST /moderation/actions.
    const action = await prisma.moderationAction.findFirst({
      where: { targetUserId: target.userId, action: "ban" },
    });
    expect(action).not.toBeNull();
    expect(action?.moderatorId).toBe(admin.userId);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "USER_BANNED", targetId: target.userId },
    });
    expect(audit).not.toBeNull();
  });

  it("maps active-from-banned onto unban and active-from-shadow onto reinstate", async () => {
    const admin = await userWithRole("platform_admin");
    const banned = await createUser();
    const shadowed = await createUser();

    await request(app)
      .patch(`${BASE}/users/${banned.userId}/status`)
      .set(...bearer(admin.token))
      .send({ status: "banned" })
      .expect(200);

    const unban = await request(app)
      .patch(`${BASE}/users/${banned.userId}/status`)
      .set(...bearer(admin.token))
      .send({ status: "active" })
      .expect(200);
    expect(unban.body.data.action.action).toBe("unban");

    await request(app)
      .patch(`${BASE}/users/${shadowed.userId}/status`)
      .set(...bearer(admin.token))
      .send({ status: "shadow_banned" })
      .expect(200);

    const reinstate = await request(app)
      .patch(`${BASE}/users/${shadowed.userId}/status`)
      .set(...bearer(admin.token))
      .send({ status: "active" })
      .expect(200);
    expect(reinstate.body.data.action.action).toBe("reinstate");
  });

  it("409s setting the status already held", async () => {
    const admin = await userWithRole("platform_admin");
    const target = await createUser();

    await request(app)
      .patch(`${BASE}/users/${target.userId}/status`)
      .set(...bearer(admin.token))
      .send({ status: "active" })
      .expect(409);
  });

  it("404s a user that does not exist", async () => {
    const admin = await userWithRole("platform_admin");

    await request(app)
      .patch(`${BASE}/users/00000000-0000-4000-8000-000000000000/status`)
      .set(...bearer(admin.token))
      .send({ status: "banned" })
      .expect(404);
  });

  it("422s an unknown status", async () => {
    const admin = await userWithRole("platform_admin");
    const target = await createUser();

    await request(app)
      .patch(`${BASE}/users/${target.userId}/status`)
      .set(...bearer(admin.token))
      .send({ status: "vaporized" })
      .expect(422);
  });

  it("lets a moderator set status, unlike role", async () => {
    const moderator = await userWithRole("moderator");
    const target = await createUser();

    await request(app)
      .patch(`${BASE}/users/${target.userId}/status`)
      .set(...bearer(moderator.token))
      .send({ status: "banned" })
      .expect(200);
  });
});

/* ── Analytics (ruling R15) ──────────────────────────────────────────────── */

describe("GET /admin/stats", () => {
  it("returns exactly the four counters the shipped Overview renders", async () => {
    const admin = await userWithRole("platform_admin");

    const response = await request(app)
      .get(`${BASE}/stats`)
      .set(...bearer(admin.token))
      .expect(200);

    expect(Object.keys(response.body.data).sort()).toEqual([
      "pendingReportsCount",
      "totalCommunities",
      "totalProjects",
      "totalUsers",
    ]);

    for (const value of Object.values(response.body.data)) {
      expect(typeof value).toBe("number");
      expect(value as number).toBeGreaterThanOrEqual(0);
    }
  });

  it("counts the users it can see", async () => {
    const admin = await userWithRole("platform_admin");

    const before = await request(app)
      .get(`${BASE}/stats`)
      .set(...bearer(admin.token))
      .expect(200);

    await createUser();

    const after = await request(app)
      .get(`${BASE}/stats`)
      .set(...bearer(admin.token))
      .expect(200);

    // Strictly greater, not exactly +1: vitest runs test files in parallel and
    // other suites register their own users against the same database. The
    // property worth asserting is that the counter responds to a new signup,
    // not that this suite had the database to itself.
    expect(after.body.data.totalUsers).toBeGreaterThan(before.body.data.totalUsers);
  });
});

describe("GET /admin/analytics/signups", () => {
  it("returns eight buckets in the shipped chart's shape", async () => {
    const admin = await userWithRole("platform_admin");

    const response = await request(app)
      .get(`${BASE}/analytics/signups`)
      .set(...bearer(admin.token))
      .expect(200);

    const signups = response.body.data.signups;
    expect(signups).toHaveLength(8);

    for (const bucket of signups) {
      expect(Object.keys(bucket).sort()).toEqual(["count", "weekLabel"]);
      expect(typeof bucket.weekLabel).toBe("string");
      expect(bucket.weekLabel).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
      expect(typeof bucket.count).toBe("number");
    }
  });

  it("counts a brand-new signup in the final bucket", async () => {
    const admin = await userWithRole("platform_admin");

    const before = await request(app)
      .get(`${BASE}/analytics/signups`)
      .set(...bearer(admin.token))
      .expect(200);

    await createUser();

    const after = await request(app)
      .get(`${BASE}/analytics/signups`)
      .set(...bearer(admin.token))
      .expect(200);

    const last = (body: { data: { signups: { count: number }[] } }) =>
      body.data.signups[body.data.signups.length - 1]!.count;

    // Strictly greater, for the same reason as the stats counter above:
    // concurrent suites also create users, and they land in this same bucket.
    expect(last(after.body)).toBeGreaterThan(last(before.body));
  });
});

describe("GET /admin/analytics/reports-by-reason", () => {
  it("returns the shipped chart's shape and omits zero counts", async () => {
    const admin = await userWithRole("platform_admin");

    const response = await request(app)
      .get(`${BASE}/analytics/reports-by-reason`)
      .set(...bearer(admin.token))
      .expect(200);

    for (const row of response.body.data.reasons) {
      expect(Object.keys(row).sort()).toEqual(["count", "reason"]);
      expect(row.count).toBeGreaterThan(0);
    }
  });

  it("reflects a newly filed report", async () => {
    const admin = await userWithRole("platform_admin");
    const reporter = await createUser();
    const author = await createUser();

    const post = await request(app)
      .post("/api/v1/posts")
      .set(...bearer(author.token))
      .send({ type: "text", content: "Reportable." })
      .expect(201);

    await request(app)
      .post("/api/v1/moderation/reports")
      .set(...bearer(reporter.token))
      .send({
        targetType: "post",
        targetId: post.body.data.post.id,
        reason: "impersonation",
      })
      .expect(201);

    const response = await request(app)
      .get(`${BASE}/analytics/reports-by-reason`)
      .set(...bearer(admin.token))
      .expect(200);

    const row = response.body.data.reasons.find(
      (r: { reason: string }) => r.reason === "impersonation",
    );
    expect(row?.count).toBeGreaterThan(0);
  });
});

/* ── Audit logs ──────────────────────────────────────────────────────────── */

describe("GET /admin/audit-logs", () => {
  it("returns a page of records to a platform admin", async () => {
    const admin = await userWithRole("platform_admin");
    const target = await createUser();

    await request(app)
      .patch(`${BASE}/users/${target.userId}/role`)
      .set(...bearer(admin.token))
      .send({ role: "verified_builder" })
      .expect(200);

    const response = await request(app)
      .get(`${BASE}/audit-logs`)
      .query({ action: "ROLE_CHANGED", targetId: target.userId })
      .set(...bearer(admin.token))
      .expect(200);

    expect(response.body.pagination.total).toBe(1);

    const row = response.body.data[0];
    expect(row.action).toBe("ROLE_CHANGED");
    expect(row.actor.id).toBe(admin.userId);
    expect(Object.keys(row.actor).sort()).toEqual(["displayName", "id", "username"]);
  });

  it("orders newest first", async () => {
    const admin = await userWithRole("platform_admin");

    const response = await request(app)
      .get(`${BASE}/audit-logs`)
      .query({ limit: 50 })
      .set(...bearer(admin.token))
      .expect(200);

    const times = response.body.data.map((row: { createdAt: string }) =>
      new Date(row.createdAt).getTime(),
    );
    expect(times).toEqual([...times].sort((a: number, b: number) => b - a));
  });

  it("filters by actor and by target type", async () => {
    const admin = await userWithRole("platform_admin");
    const target = await createUser();

    await request(app)
      .patch(`${BASE}/users/${target.userId}/status`)
      .set(...bearer(admin.token))
      .send({ status: "banned" })
      .expect(200);

    const response = await request(app)
      .get(`${BASE}/audit-logs`)
      .query({ actorId: admin.userId, targetType: "user", limit: 50 })
      .set(...bearer(admin.token))
      .expect(200);

    expect(response.body.pagination.total).toBeGreaterThan(0);
    for (const row of response.body.data) {
      expect(row.actorId).toBe(admin.userId);
      expect(row.targetType).toBe("user");
    }
  });

  it("422s a malformed actorId and an unknown target type", async () => {
    const admin = await userWithRole("platform_admin");

    await request(app)
      .get(`${BASE}/audit-logs`)
      .query({ actorId: "nope" })
      .set(...bearer(admin.token))
      .expect(422);

    await request(app)
      .get(`${BASE}/audit-logs`)
      .query({ targetType: "spaceship" })
      .set(...bearer(admin.token))
      .expect(422);
  });

  it("returns an empty page rather than erroring when nothing matches", async () => {
    const admin = await userWithRole("platform_admin");

    const response = await request(app)
      .get(`${BASE}/audit-logs`)
      .query({ action: "NEVER_WRITTEN_VERB" })
      .set(...bearer(admin.token))
      .expect(200);

    expect(response.body.data).toHaveLength(0);
    expect(response.body.pagination.total).toBe(0);
  });
});
