import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The audit trail (TRD §29, ARCHITECTURE §26, §27 layer 9).
 *
 * §29 sets two requirements this file exists to hold the code to:
 *
 *   - *"Track security-sensitive and administrative actions."* Every verb §26
 *     and §29 name by hand — `ROLE_CHANGED`, `USER_BANNED`, `POST_REMOVED`,
 *     login, logout, password change — must actually be written.
 *   - *"Audit logs must not be editable by normal users."* There is no update
 *     and no delete anywhere in the audit repository, and no API route that
 *     writes a row directly. This asserts both.
 *
 * And ruling R9's addition: a moderation mutation and its audit record share a
 * transaction, so no action can commit without its record.
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
const { AuditAction } = await import("../src/utils/audit.js");
const auditRepo = await import("../src/repositories/audit.repository.js");

const app = createApp();

const NS = "auditflow";
const PASSWORD = "ValidPass123";

let counter = 0;
function uniqueEmail(): string {
  counter += 1;
  return `${NS}.${String(counter)}.${String(Date.now())}@forgehub.test`;
}

interface TestUser {
  userId: string;
  username: string;
  token: string;
  email: string;
}

async function createUser(): Promise<TestUser> {
  const email = uniqueEmail();

  await request(app)
    .post("/api/v1/auth/register")
    .send({
      displayName: "Audit Tester",
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
    email,
  };
}

async function userWithRole(role: "moderator" | "platform_admin"): Promise<TestUser> {
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

/* ── The vocabulary the specifications name ──────────────────────────────── */

describe("the audited vocabulary", () => {
  it("carries every verb ARCHITECTURE §26 names by hand", () => {
    for (const verb of [
      "USER_LOGIN",
      "PASSWORD_CHANGED",
      "ROLE_CHANGED",
      "USER_BANNED",
      "POST_REMOVED",
      "PROJECT_DELETED",
      "COMMUNITY_ROLE_CHANGED",
    ] as const) {
      expect(Object.values(AuditAction)).toContain(verb);
    }
  });

  it("carries a verb for each moderation outcome TRD §28 requires", () => {
    for (const verb of [
      "USER_WARNED",
      "USER_SUSPENDED",
      "USER_BANNED",
      "USER_UNBANNED",
      "USER_REINSTATED",
      "REPORT_CREATED",
      "REPORT_REVIEWED",
      "REPORT_RESOLVED",
      "REPORT_DISMISSED",
    ] as const) {
      expect(Object.values(AuditAction)).toContain(verb);
    }
  });

  it("names removal per content type rather than generically", () => {
    for (const verb of [
      "POST_REMOVED",
      "COMMENT_REMOVED",
      "PROJECT_REMOVED",
      "COMMUNITY_REMOVED",
      "MESSAGE_REMOVED",
    ] as const) {
      expect(Object.values(AuditAction)).toContain(verb);
    }
  });

  it("has no duplicate values", () => {
    const values = Object.values(AuditAction);
    expect(new Set(values).size).toBe(values.length);
  });
});

/* ── Append-only (TRD §29) ───────────────────────────────────────────────── */

describe("the audit table is append-only", () => {
  it("exposes an insert and reads, and no mutator at all", () => {
    const exported = Object.keys(auditRepo).sort();
    expect(exported).toEqual(["insertAuditLog", "listAuditLogs"]);

    // Stated as an assertion rather than a comment: adding an update or
    // delete here should break this test.
    for (const name of exported) {
      expect(name).not.toMatch(/update|delete|remove|edit/i);
    }
  });

  it("has no API route that writes a record directly", async () => {
    const admin = await userWithRole("platform_admin");
    const before = await prisma.auditLog.count({ where: { action: "FORGED" } });

    for (const path of ["/api/v1/admin/audit-logs", "/api/v1/audit-logs"]) {
      await request(app)
        .post(path)
        .set(...bearer(admin.token))
        .send({ action: "FORGED", actorId: admin.userId })
        .expect(404);
    }

    expect(await prisma.auditLog.count({ where: { action: "FORGED" } })).toBe(before);
  });

  it("cannot be edited by an ordinary user through any route", async () => {
    const member = await createUser();

    for (const method of ["post", "patch", "delete"] as const) {
      await request(app)
        [method]("/api/v1/admin/audit-logs")
        .set(...bearer(member.token))
        .send({ action: "TAMPERED" });
    }

    // Scoped to the verb this test tried to inject rather than a global count:
    // vitest runs test files in parallel and every login in every other suite
    // legitimately appends a row, so a total would be racing them.
    expect(await prisma.auditLog.count({ where: { action: "TAMPERED" } })).toBe(0);
  });
});

/* ── Transactional durability (ruling R9) ────────────────────────────────── */

describe("moderation mutations and their audit rows commit together", () => {
  it("writes exactly one audit row per moderation action", async () => {
    const moderator = await userWithRole("moderator");
    const offender = await createUser();

    await request(app)
      .post("/api/v1/moderation/actions")
      .set(...bearer(moderator.token))
      .send({ action: "warning", targetType: "user", targetId: offender.userId })
      .expect(201);

    const actions = await prisma.moderationAction.count({
      where: { targetUserId: offender.userId },
    });
    const audits = await prisma.auditLog.count({
      where: { action: "USER_WARNED", targetId: offender.userId },
    });

    expect(actions).toBe(1);
    expect(audits).toBe(1);
  });

  it("leaves neither behind when the action is refused", async () => {
    const moderator = await userWithRole("moderator");
    const superior = await userWithRole("platform_admin");

    await request(app)
      .post("/api/v1/moderation/actions")
      .set(...bearer(moderator.token))
      .send({ action: "ban", targetType: "user", targetId: superior.userId })
      .expect(403);

    expect(
      await prisma.moderationAction.count({ where: { targetUserId: superior.userId } }),
    ).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: { action: "USER_BANNED", targetId: superior.userId },
      }),
    ).toBe(0);
  });

  it("keeps the status change and the record in step across several actions", async () => {
    const moderator = await userWithRole("moderator");
    const offender = await createUser();

    for (const action of ["ban", "unban", "shadow_ban", "reinstate"] as const) {
      await request(app)
        .post("/api/v1/moderation/actions")
        .set(...bearer(moderator.token))
        .send({ action, targetType: "user", targetId: offender.userId })
        .expect(201);
    }

    const actions = await prisma.moderationAction.count({
      where: { targetUserId: offender.userId },
    });
    const audits = await prisma.auditLog.count({
      where: {
        targetId: offender.userId,
        action: {
          in: ["USER_BANNED", "USER_UNBANNED", "USER_SHADOW_BANNED", "USER_REINSTATED"],
        },
      },
    });

    expect(actions).toBe(4);
    expect(audits).toBe(4);

    const user = await prisma.user.findUnique({ where: { id: offender.userId } });
    expect(user?.status).toBe("active");
  });
});

/* ── Content of the record ───────────────────────────────────────────────── */

describe("what a record carries", () => {
  it("captures the actor, the target, and the request context", async () => {
    const moderator = await userWithRole("moderator");
    const offender = await createUser();

    await request(app)
      .post("/api/v1/moderation/actions")
      .set(...bearer(moderator.token))
      .set("User-Agent", "vitest-audit-agent")
      .send({ action: "ban", targetType: "user", targetId: offender.userId })
      .expect(201);

    const row = await prisma.auditLog.findFirst({
      where: { action: "USER_BANNED", targetId: offender.userId },
    });

    // ARCHITECTURE §26: actor, action, target, target id, timestamp, metadata,
    // IP where appropriate.
    expect(row?.actorId).toBe(moderator.userId);
    expect(row?.targetType).toBe("user");
    expect(row?.targetId).toBe(offender.userId);
    expect(row?.createdAt).toBeInstanceOf(Date);
    expect(row?.userAgent).toBe("vitest-audit-agent");
    expect(row?.metadata).toMatchObject({ action: "ban", statusChanged: true });
  });

  it("never records a password, a token, or a hash", async () => {
    const user = await createUser();

    await request(app)
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: PASSWORD, rememberMe: false })
      .expect(200);

    const rows = await prisma.auditLog.findMany({
      where: { actorId: user.userId },
      select: { metadata: true },
    });

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain("passwordHash");
    expect(serialized).not.toContain("accessToken");
    expect(serialized).not.toContain("refreshToken");
  });

  it("records the login the specifications name", async () => {
    const user = await createUser();

    const rows = await prisma.auditLog.findMany({
      where: { actorId: user.userId, action: "USER_LOGIN" },
    });
    expect(rows.length).toBeGreaterThan(0);
  });

  it("survives the deletion of its actor", async () => {
    // `AuditLog.actor` is `SetNull`: the record must outlive the account.
    const moderator = await userWithRole("moderator");
    const offender = await createUser();

    await request(app)
      .post("/api/v1/moderation/actions")
      .set(...bearer(moderator.token))
      .send({ action: "warning", targetType: "user", targetId: offender.userId })
      .expect(201);

    const before = await prisma.auditLog.findFirst({
      where: { action: "USER_WARNED", targetId: offender.userId },
    });
    expect(before?.actorId).toBe(moderator.userId);

    await prisma.moderationAction.deleteMany({
      where: { moderatorId: moderator.userId },
    });
    await prisma.user.delete({ where: { id: moderator.userId } });

    const after = await prisma.auditLog.findUnique({ where: { id: before!.id } });
    expect(after).not.toBeNull();
    expect(after?.actorId).toBeNull();
    expect(after?.action).toBe("USER_WARNED");
  });
});

/* ── The transaction-client extension ────────────────────────────────────── */

describe("insertAuditLog's optional transaction client", () => {
  it("writes through the shared client when none is given", async () => {
    const user = await createUser();

    await auditRepo.insertAuditLog({
      actorId: user.userId,
      action: "PHASE11_DIRECT_WRITE",
      targetType: "user",
      targetId: user.userId,
      metadata: null,
      ipAddress: null,
      userAgent: null,
    });

    const row = await prisma.auditLog.findFirst({
      where: { action: "PHASE11_DIRECT_WRITE", actorId: user.userId },
    });
    expect(row).not.toBeNull();
    // A null metadata means SQL NULL, not JSON null.
    expect(row?.metadata).toBeNull();
  });

  it("rolls back with its caller's transaction", async () => {
    const user = await createUser();

    await expect(
      prisma.$transaction(async (tx) => {
        await auditRepo.insertAuditLog(
          {
            actorId: user.userId,
            action: "PHASE11_ROLLED_BACK",
            targetType: "user",
            targetId: user.userId,
            metadata: null,
            ipAddress: null,
            userAgent: null,
          },
          tx,
        );

        throw new Error("deliberate rollback");
      }),
    ).rejects.toThrow("deliberate rollback");

    const row = await prisma.auditLog.findFirst({
      where: { action: "PHASE11_ROLLED_BACK" },
    });
    expect(row).toBeNull();
  });
});
