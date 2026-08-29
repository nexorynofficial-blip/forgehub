import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Administration security regressions (TRD §14, §29, ARCHITECTURE §18, §26).
 *
 * The two routes this file cares about most are the two the backend
 * deliberately gates more tightly than the shipped frontend does:
 *
 *   - **`PATCH /admin/users/:id/role`.** `user-row.tsx` renders a role
 *     selector containing `platform_admin` to every staff role and its mock
 *     has no guard at all. Mirroring that server-side would let any moderator
 *     promote themselves — the single worst outcome available in this phase.
 *   - **`GET /admin/audit-logs`.** The trail carries every login, IP address,
 *     and user agent on the platform.
 *
 * Everything here is an attack, not a feature.
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

const NS = "adminsec";
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
      displayName: "Admin Security Tester",
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

type Role =
  "member" | "verified_builder" | "moderator" | "community_admin" | "platform_admin";

async function userWithRole(role: Role): Promise<TestUser> {
  const user = await createUser();
  if (role !== "member") {
    await prisma.user.update({ where: { id: user.userId }, data: { role } });
  }
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
    await prisma.notification.deleteMany({
      where: { OR: [{ userId: { in: ids } }, { actorId: { in: ids } }] },
    });
    await prisma.auditLog.deleteMany({
      where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] },
    });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  await prisma.$disconnect();
  await redis.quit();
});

/* ── Authentication ──────────────────────────────────────────────────────── */

describe("anonymous callers", () => {
  const ROUTES = [
    `${BASE}/users`,
    `${BASE}/stats`,
    `${BASE}/analytics/signups`,
    `${BASE}/analytics/reports-by-reason`,
    `${BASE}/audit-logs`,
  ];

  it.each(ROUTES)("401s GET %s", async (path) => {
    await request(app).get(path).expect(401);
  });

  it("401s both mutation routes", async () => {
    const id = "00000000-0000-4000-8000-000000000000";

    await request(app)
      .patch(`${BASE}/users/${id}/role`)
      .send({ role: "moderator" })
      .expect(401);
    await request(app)
      .patch(`${BASE}/users/${id}/status`)
      .send({ status: "banned" })
      .expect(401);
  });

  it("rejects a forged bearer token", async () => {
    await request(app)
      .get(`${BASE}/users`)
      .set("Authorization", "Bearer forged.token.value")
      .expect(401);
  });

  it("answers 401 before 403, never conflating the two", async () => {
    // ARCHITECTURE §18 warns against confusing "who are you?" with "may you?".
    const anonymous = await request(app).get(`${BASE}/audit-logs`);
    expect(anonymous.status).toBe(401);

    const member = await userWithRole("member");
    const authenticated = await request(app)
      .get(`${BASE}/audit-logs`)
      .set(...bearer(member.token));
    expect(authenticated.status).toBe(403);
  });
});

/* ── The staff boundary ──────────────────────────────────────────────────── */

describe("ordinary users", () => {
  const OUTSIDERS: Role[] = ["member", "verified_builder"];

  it.each(OUTSIDERS)("403s %s on every admin read", async (role) => {
    const user = await userWithRole(role);

    for (const path of [
      `${BASE}/users`,
      `${BASE}/stats`,
      `${BASE}/analytics/signups`,
      `${BASE}/analytics/reports-by-reason`,
    ]) {
      await request(app)
        .get(path)
        .set(...bearer(user.token))
        .expect(403);
    }
  });

  it.each(OUTSIDERS)("403s %s on both mutations", async (role) => {
    const user = await userWithRole(role);
    const target = await createUser();

    await request(app)
      .patch(`${BASE}/users/${target.userId}/role`)
      .set(...bearer(user.token))
      .send({ role: "moderator" })
      .expect(403);

    await request(app)
      .patch(`${BASE}/users/${target.userId}/status`)
      .set(...bearer(user.token))
      .send({ status: "banned" })
      .expect(403);
  });
});

/* ── Role escalation — the central risk ──────────────────────────────────── */

describe("role escalation is impossible", () => {
  it("403s a moderator promoting anyone to platform_admin", async () => {
    const moderator = await userWithRole("moderator");
    const target = await createUser();

    await request(app)
      .patch(`${BASE}/users/${target.userId}/role`)
      .set(...bearer(moderator.token))
      .send({ role: "platform_admin" })
      .expect(403);

    const stored = await prisma.user.findUnique({ where: { id: target.userId } });
    expect(stored?.role).toBe("member");
  });

  it("403s a community admin promoting anyone to platform_admin", async () => {
    const communityAdmin = await userWithRole("community_admin");
    const target = await createUser();

    await request(app)
      .patch(`${BASE}/users/${target.userId}/role`)
      .set(...bearer(communityAdmin.token))
      .send({ role: "platform_admin" })
      .expect(403);
  });

  it("403s a moderator promoting themselves", async () => {
    const moderator = await userWithRole("moderator");

    await request(app)
      .patch(`${BASE}/users/${moderator.userId}/role`)
      .set(...bearer(moderator.token))
      .send({ role: "platform_admin" })
      .expect(403);

    const stored = await prisma.user.findUnique({ where: { id: moderator.userId } });
    expect(stored?.role).toBe("moderator");
  });

  it("403s a moderator making any role change at all", async () => {
    const moderator = await userWithRole("moderator");
    const target = await createUser();

    for (const role of ["member", "verified_builder", "moderator"]) {
      await request(app)
        .patch(`${BASE}/users/${target.userId}/role`)
        .set(...bearer(moderator.token))
        .send({ role })
        .expect(403);
    }
  });

  it("403s a platform admin changing their own role", async () => {
    const admin = await userWithRole("platform_admin");

    await request(app)
      .patch(`${BASE}/users/${admin.userId}/role`)
      .set(...bearer(admin.token))
      .send({ role: "member" })
      .expect(403);

    const stored = await prisma.user.findUnique({ where: { id: admin.userId } });
    expect(stored?.role).toBe("platform_admin");
  });

  it("403s a platform admin demoting another platform admin", async () => {
    const [actor, peer] = [
      await userWithRole("platform_admin"),
      await userWithRole("platform_admin"),
    ];

    await request(app)
      .patch(`${BASE}/users/${peer.userId}/role`)
      .set(...bearer(actor.token))
      .send({ role: "member" })
      .expect(403);

    const stored = await prisma.user.findUnique({ where: { id: peer.userId } });
    expect(stored?.role).toBe("platform_admin");
  });

  it("403s assigning the guest sentinel", async () => {
    const admin = await userWithRole("platform_admin");
    const target = await createUser();

    await request(app)
      .patch(`${BASE}/users/${target.userId}/role`)
      .set(...bearer(admin.token))
      .send({ role: "guest" })
      .expect(403);
  });

  it("writes no audit row for a refused role change", async () => {
    const moderator = await userWithRole("moderator");
    const target = await createUser();

    await request(app)
      .patch(`${BASE}/users/${target.userId}/role`)
      .set(...bearer(moderator.token))
      .send({ role: "platform_admin" })
      .expect(403);

    const audit = await prisma.auditLog.findMany({
      where: { action: "ROLE_CHANGED", targetId: target.userId },
    });
    expect(audit).toHaveLength(0);
  });

  it("lets a platform admin do what everyone else was refused", async () => {
    // The negative tests above are only meaningful if the positive one works.
    const admin = await userWithRole("platform_admin");
    const target = await createUser();

    await request(app)
      .patch(`${BASE}/users/${target.userId}/role`)
      .set(...bearer(admin.token))
      .send({ role: "platform_admin" })
      .expect(200);
  });
});

/* ── Rank on status changes ──────────────────────────────────────────────── */

describe("status changes respect rank", () => {
  it("403s a moderator banning a platform admin", async () => {
    const moderator = await userWithRole("moderator");
    const admin = await userWithRole("platform_admin");

    await request(app)
      .patch(`${BASE}/users/${admin.userId}/status`)
      .set(...bearer(moderator.token))
      .send({ status: "banned" })
      .expect(403);

    const stored = await prisma.user.findUnique({ where: { id: admin.userId } });
    expect(stored?.status).toBe("active");
  });

  it("403s a moderator banning themselves", async () => {
    const moderator = await userWithRole("moderator");

    await request(app)
      .patch(`${BASE}/users/${moderator.userId}/status`)
      .set(...bearer(moderator.token))
      .send({ status: "banned" })
      .expect(403);
  });

  it("403s a platform admin banning another platform admin", async () => {
    const [actor, peer] = [
      await userWithRole("platform_admin"),
      await userWithRole("platform_admin"),
    ];

    await request(app)
      .patch(`${BASE}/users/${peer.userId}/status`)
      .set(...bearer(actor.token))
      .send({ status: "banned" })
      .expect(403);
  });
});

/* ── Audit-log access (ruling R5) ────────────────────────────────────────── */

describe("audit logs are platform_admin only", () => {
  const REFUSED: Role[] = ["member", "verified_builder", "moderator", "community_admin"];

  it.each(REFUSED)("403s %s", async (role) => {
    const user = await userWithRole(role);

    await request(app)
      .get(`${BASE}/audit-logs`)
      .set(...bearer(user.token))
      .expect(403);
  });

  it("admits a platform admin", async () => {
    const admin = await userWithRole("platform_admin");

    await request(app)
      .get(`${BASE}/audit-logs`)
      .set(...bearer(admin.token))
      .expect(200);
  });

  it("is stricter than the rest of the admin surface", async () => {
    // A moderator can read the user table but not the trail.
    const moderator = await userWithRole("moderator");

    await request(app)
      .get(`${BASE}/users`)
      .set(...bearer(moderator.token))
      .expect(200);

    await request(app)
      .get(`${BASE}/audit-logs`)
      .set(...bearer(moderator.token))
      .expect(403);
  });

  it("exposes no write or delete route, for any role", async () => {
    const admin = await userWithRole("platform_admin");

    for (const method of ["post", "patch", "put", "delete"] as const) {
      const response = await request(app)
        [method](`${BASE}/audit-logs`)
        .set(...bearer(admin.token))
        .send({ action: "FABRICATED", actorId: admin.userId });

      // 404 from the router; the table is append-only and has no editor.
      expect(response.status).toBe(404);
    }
  });

  it("cannot be written through the read route's query string", async () => {
    const admin = await userWithRole("platform_admin");

    const before = await prisma.auditLog.count({ where: { action: "FABRICATED" } });

    await request(app)
      .get(`${BASE}/audit-logs`)
      .query({ action: "FABRICATED", actorId: admin.userId })
      .set(...bearer(admin.token))
      .expect(200);

    const after = await prisma.auditLog.count({ where: { action: "FABRICATED" } });
    expect(after).toBe(before);
  });
});

/* ── Client-supplied identity ────────────────────────────────────────────── */

describe("client-supplied identity is ignored", () => {
  it("ignores an actorId injected into a role change", async () => {
    const admin = await userWithRole("platform_admin");
    const impersonated = await userWithRole("platform_admin");
    const target = await createUser();

    await request(app)
      .patch(`${BASE}/users/${target.userId}/role`)
      .set(...bearer(admin.token))
      .send({ role: "moderator", actorId: impersonated.userId })
      .expect(200);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "ROLE_CHANGED", targetId: target.userId },
    });
    expect(audit?.actorId).toBe(admin.userId);
  });

  it("ignores a moderatorId injected into a status change", async () => {
    const admin = await userWithRole("platform_admin");
    const impersonated = await userWithRole("platform_admin");
    const target = await createUser();

    const response = await request(app)
      .patch(`${BASE}/users/${target.userId}/status`)
      .set(...bearer(admin.token))
      .send({ status: "banned", moderatorId: impersonated.userId })
      .expect(200);

    expect(response.body.data.action.moderatorId).toBe(admin.userId);
  });

  it("ignores a userId in the body, taking the target from the path only", async () => {
    const admin = await userWithRole("platform_admin");
    const pathTarget = await createUser();
    const bodyTarget = await createUser();

    await request(app)
      .patch(`${BASE}/users/${pathTarget.userId}/status`)
      .set(...bearer(admin.token))
      .send({ status: "banned", userId: bodyTarget.userId, id: bodyTarget.userId })
      .expect(200);

    expect(
      (await prisma.user.findUnique({ where: { id: pathTarget.userId } }))?.status,
    ).toBe("banned");
    expect(
      (await prisma.user.findUnique({ where: { id: bodyTarget.userId } }))?.status,
    ).toBe("active");
  });
});

/* ── Banned staff ────────────────────────────────────────────────────────── */

describe("a banned administrator", () => {
  it("loses access on their next request", async () => {
    const admin = await userWithRole("platform_admin");
    const rogue = await userWithRole("moderator");

    await request(app)
      .get(`${BASE}/users`)
      .set(...bearer(rogue.token))
      .expect(200);

    await request(app)
      .patch(`${BASE}/users/${rogue.userId}/status`)
      .set(...bearer(admin.token))
      .send({ status: "banned" })
      .expect(200);

    await request(app)
      .get(`${BASE}/users`)
      .set(...bearer(rogue.token))
      .expect(403);
  });
});
