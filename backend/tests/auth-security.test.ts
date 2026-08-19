import express, { type Express } from "express";
import pino from "pino";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Security properties of the auth surface, as opposed to its happy paths.
 *
 * Every test here asserts something that would still let the product "work"
 * if it broke — a leaked hash, a role check that trusts the token instead of
 * the database, an error message that distinguishes a real account from a
 * fictional one. Those are exactly the regressions integration tests miss.
 */

const { mailbox } = vi.hoisted(() => ({
  mailbox: [] as Array<{ kind: string; to: string; token?: string }>,
}));

vi.mock("../src/integrations/email/index.js", () => ({
  emailService: {
    providerName: "test",
    sendVerificationEmail: (to: string, o: { token: string }) => {
      mailbox.push({ kind: "verify", to, token: o.token });
      return Promise.resolve();
    },
    sendPasswordResetEmail: (to: string, o: { token: string }) => {
      mailbox.push({ kind: "reset", to, token: o.token });
      return Promise.resolve();
    },
    sendSecurityAlertEmail: () => Promise.resolve(),
  },
}));

const { createApp } = await import("../src/app.js");
const { prisma } = await import("../src/database/prisma.js");
const { connectRedis, redis } = await import("../src/config/redis.js");
const { requireAuth } = await import("../src/middleware/auth.middleware.js");
const { assertOwnershipOrAdmin, isAdminRole, requireAdmin, requireRole } =
  await import("../src/middleware/role.middleware.js");
const { errorHandler } = await import("../src/middleware/error.middleware.js");
const { successResponse } = await import("../src/utils/response.js");
const { REDACTED_PATHS } = await import("../src/utils/logger.js");

const app = createApp();

const NS = "sectest";
const PASSWORD = "ValidPass123";

let counter = 0;
function uniqueEmail(): string {
  counter += 1;
  return `${NS}.${String(counter)}.${String(Date.now())}@forgehub.test`;
}

interface TestUser {
  email: string;
  userId: string;
  accessToken: string;
}

async function createUser(displayName = "Security Tester"): Promise<TestUser> {
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
    accessToken: login.body.data.accessToken as string,
  };
}

function bearer(token: string): [string, string] {
  return ["Authorization", `Bearer ${token}`];
}

/**
 * A minimal app exposing the authorization middleware directly.
 *
 * Phase 3 ships no role-gated endpoint of its own — the admin surface is
 * Phase 11 — but the middleware is written now and must be proven now, or it
 * lands unverified in the phase that depends on it.
 */
function createGuardedApp(): Express {
  const guarded = express();
  guarded.use(express.json());

  guarded.get("/admin", requireAuth, requireAdmin, (_req, res) => {
    res.json(successResponse({ ok: true }));
  });

  guarded.get("/moderator", requireAuth, requireRole("moderator"), (_req, res) => {
    res.json(successResponse({ ok: true }));
  });

  guarded.get("/owned/:ownerId", requireAuth, (req, res) => {
    assertOwnershipOrAdmin(req, req.params.ownerId as string);
    res.json(successResponse({ ok: true }));
  });

  guarded.use(errorHandler);
  return guarded;
}

const guardedApp = createGuardedApp();

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

describe("Credential exposure", () => {
  it("never returns passwordHash from any auth endpoint", async () => {
    const user = await createUser();

    const responses = await Promise.all([
      request(app)
        .get("/api/v1/auth/me")
        .set(...bearer(user.accessToken)),
      request(app)
        .post("/api/v1/auth/login")
        .send({ email: user.email, password: PASSWORD, rememberMe: false }),
      request(app)
        .get("/api/v1/auth/sessions")
        .set(...bearer(user.accessToken)),
    ]);

    for (const response of responses) {
      const body = JSON.stringify(response.body);
      expect(body).not.toContain("passwordHash");
      expect(body).not.toContain("$argon2");
      expect(body).not.toContain(PASSWORD);
    }
  });

  it("never echoes the submitted password back in a validation error", async () => {
    const response = await request(app)
      .post("/api/v1/auth/register")
      .send({
        displayName: "Echo Check",
        email: uniqueEmail(),
        password: "weak",
        confirmPassword: "weak",
        agreeToTerms: true,
      })
      .expect(422);

    expect(JSON.stringify(response.body)).not.toContain("weak");
  });

  it("never exposes a stored TOTP secret after enrollment", async () => {
    const user = await createUser("Secret Exposure");

    await request(app)
      .post("/api/v1/auth/2fa/setup")
      .set(...bearer(user.accessToken))
      .expect(200);

    const stored = await prisma.twoFactorCredential.findUniqueOrThrow({
      where: { userId: user.userId },
    });

    const me = await request(app)
      .get("/api/v1/auth/me")
      .set(...bearer(user.accessToken))
      .expect(200);

    expect(JSON.stringify(me.body)).not.toContain(stored.secret);
    expect(me.body.data.user).not.toHaveProperty("secret");
  });

  it("stores backup codes as hashes, never as the codes themselves", async () => {
    const user = await createUser("Backup Storage");

    const setup = await request(app)
      .post("/api/v1/auth/2fa/setup")
      .set(...bearer(user.accessToken))
      .expect(200);

    const { generate } = await import("otplib");
    const confirm = await request(app)
      .post("/api/v1/auth/2fa/confirm")
      .set(...bearer(user.accessToken))
      .send({ code: await generate({ secret: setup.body.data.secret as string }) })
      .expect(200);

    const stored = await prisma.twoFactorCredential.findUniqueOrThrow({
      where: { userId: user.userId },
    });
    const codes = confirm.body.data.backupCodes as string[];

    expect(stored.backupCodes).toHaveLength(codes.length);
    for (const code of codes) {
      expect(stored.backupCodes).not.toContain(code);
    }
  });

  it("stores only hashes for refresh, verification, and reset tokens", async () => {
    const user = await createUser("Token Storage");

    await request(app)
      .post("/api/v1/auth/password/forgot")
      .send({ email: user.email })
      .expect(200);

    const resetToken = mailbox.findLast((m) => m.kind === "reset")?.token ?? "";
    const [refreshRows, resetRows, verifyRows] = await Promise.all([
      prisma.refreshToken.findMany({ where: { session: { userId: user.userId } } }),
      prisma.passwordResetToken.findMany({ where: { userId: user.userId } }),
      prisma.emailVerificationToken.findMany({ where: { userId: user.userId } }),
    ]);

    expect(resetRows.length).toBeGreaterThan(0);
    for (const row of [...refreshRows, ...resetRows, ...verifyRows]) {
      // Hex digest, never the base64url token that was actually issued.
      expect(row.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(row.tokenHash).not.toBe(resetToken);
    }
  });

  it("keeps credentials out of audit metadata", async () => {
    const user = await createUser("Audit Hygiene");

    const entries = await prisma.auditLog.findMany({
      where: { actorId: user.userId },
    });

    expect(entries.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain("$argon2");
  });
});

describe("Log redaction (TRD §30)", () => {
  it("censors every credential-bearing field the auth flows touch", () => {
    const lines: string[] = [];
    const logger = pino(
      { redact: { paths: REDACTED_PATHS, censor: "[REDACTED]" } },
      { write: (chunk: string) => lines.push(chunk) },
    );

    logger.info({
      password: "PlaintextPassword1",
      currentPassword: "OldPassword1",
      newPassword: "NewPassword1",
      token: "opaque-token-value",
      accessToken: "jwt-value",
      refreshToken: "refresh-value",
      challengeToken: "challenge-value",
      secret: "JBSWY3DPEHPK3PXP",
      backupCodes: ["ABCDE-FGHIJ"],
      passwordHash: "$argon2id$v=19$real",
      req: {
        headers: {
          authorization: "Bearer leaked",
          cookie: "forgehub_refresh=leaked",
        },
      },
    });

    const output = lines.join("");

    for (const forbidden of [
      "PlaintextPassword1",
      "OldPassword1",
      "NewPassword1",
      "opaque-token-value",
      "jwt-value",
      "refresh-value",
      "challenge-value",
      "JBSWY3DPEHPK3PXP",
      "ABCDE-FGHIJ",
      "$argon2id$v=19$real",
      "Bearer leaked",
      "forgehub_refresh=leaked",
    ]) {
      expect(output).not.toContain(forbidden);
    }

    expect(output).toContain("[REDACTED]");
  });
});

describe("Role-based authorization", () => {
  it("denies an ordinary member an admin-gated route", async () => {
    const user = await createUser("Plain Member");

    const response = await request(guardedApp)
      .get("/admin")
      .set(...bearer(user.accessToken))
      .expect(403);

    expect(response.body.error.code).toBe("AUTHORIZATION_ERROR");
  });

  it("allows each of the three admin roles the frontend recognizes", async () => {
    for (const role of ["moderator", "community_admin", "platform_admin"] as const) {
      const user = await createUser(`Role ${role}`);
      await prisma.user.update({ where: { id: user.userId }, data: { role } });

      // Re-login so the session reflects the new role.
      const login = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: user.email, password: PASSWORD, rememberMe: false })
        .expect(200);

      await request(guardedApp)
        .get("/admin")
        .set(...bearer(login.body.data.accessToken as string))
        .expect(200);
    }
  });

  it("distinguishes a specific role from the admin group", async () => {
    const user = await createUser("Community Admin Only");
    await prisma.user.update({
      where: { id: user.userId },
      data: { role: "community_admin" },
    });

    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: PASSWORD, rememberMe: false })
      .expect(200);

    const token = login.body.data.accessToken as string;

    await request(guardedApp)
      .get("/admin")
      .set(...bearer(token))
      .expect(200);
    // …but is not a moderator.
    await request(guardedApp)
      .get("/moderator")
      .set(...bearer(token))
      .expect(403);
  });

  it("re-reads the role from the database rather than trusting the token", async () => {
    const user = await createUser("Demoted");
    await prisma.user.update({
      where: { id: user.userId },
      data: { role: "platform_admin" },
    });

    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: PASSWORD, rememberMe: false })
      .expect(200);

    const token = login.body.data.accessToken as string;
    await request(guardedApp)
      .get("/admin")
      .set(...bearer(token))
      .expect(200);

    // Demote without reissuing the token. The JWT still claims platform_admin.
    await prisma.user.update({
      where: { id: user.userId },
      data: { role: "member" },
    });

    await request(guardedApp)
      .get("/admin")
      .set(...bearer(token))
      .expect(403);
  });

  it("never treats the frontend's `guest` sentinel as authorized", () => {
    expect(isAdminRole("guest")).toBe(false);
    expect(isAdminRole("member")).toBe(false);
    expect(isAdminRole("moderator")).toBe(true);
    expect(isAdminRole("platform_admin")).toBe(true);
  });

  it("never persists `guest` as a registered user's role", async () => {
    const user = await createUser("Never Guest");
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });

    expect(row.role).toBe("member");
  });

  it("requires authentication before it considers a role at all", async () => {
    await request(guardedApp).get("/admin").expect(401);
  });
});

describe("Resource ownership", () => {
  it("allows the owner and rejects everyone else", async () => {
    const [owner, stranger] = await Promise.all([
      createUser("Owner"),
      createUser("Stranger"),
    ]);

    await request(guardedApp)
      .get(`/owned/${owner.userId}`)
      .set(...bearer(owner.accessToken))
      .expect(200);

    await request(guardedApp)
      .get(`/owned/${owner.userId}`)
      .set(...bearer(stranger.accessToken))
      .expect(403);
  });

  it("lets an admin through an ownership check", async () => {
    const owner = await createUser("Owned Resource");
    const admin = await createUser("Admin Override");

    await prisma.user.update({
      where: { id: admin.userId },
      data: { role: "platform_admin" },
    });

    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: admin.email, password: PASSWORD, rememberMe: false })
      .expect(200);

    await request(guardedApp)
      .get(`/owned/${owner.userId}`)
      .set(...bearer(login.body.data.accessToken as string))
      .expect(200);
  });

  it("does not let one user revoke another user's session", async () => {
    const [victim, attacker] = await Promise.all([
      createUser("Victim"),
      createUser("Attacker"),
    ]);

    const sessions = await request(app)
      .get("/api/v1/auth/sessions")
      .set(...bearer(victim.accessToken))
      .expect(200);

    const victimSessionId = (sessions.body.data.sessions as Array<{ id: string }>)[0]?.id;

    // 404 rather than 403: a "forbidden" would confirm the id is real.
    const response = await request(app)
      .delete(`/api/v1/auth/sessions/${victimSessionId ?? ""}`)
      .set(...bearer(attacker.accessToken))
      .expect(404);

    expect(response.body.error.code).toBe("NOT_FOUND");

    await request(app)
      .get("/api/v1/auth/me")
      .set(...bearer(victim.accessToken))
      .expect(200);
  });
});

describe("Account status enforcement", () => {
  it("stops an in-flight session the moment the account is banned", async () => {
    const user = await createUser("Ban Mid-Session");

    await request(app)
      .get("/api/v1/auth/me")
      .set(...bearer(user.accessToken))
      .expect(200);

    await prisma.user.update({
      where: { id: user.userId },
      data: { status: "banned" },
    });

    // Not "at next login" — the middleware re-reads status on every request.
    await request(app)
      .get("/api/v1/auth/me")
      .set(...bearer(user.accessToken))
      .expect(403);
  });

  it("leaves a shadow-banned account able to authenticate", async () => {
    const user = await createUser("Shadow Banned");
    await prisma.user.update({
      where: { id: user.userId },
      data: { status: "shadow_banned" },
    });

    // The point of a shadow ban is that it is invisible to its subject.
    await request(app)
      .get("/api/v1/auth/me")
      .set(...bearer(user.accessToken))
      .expect(200);
  });
});

describe("Session integrity", () => {
  it("rejects an access token whose session was revoked elsewhere", async () => {
    const user = await createUser("Cross Revoke");

    const second = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: PASSWORD, rememberMe: false })
      .expect(200);

    await request(app)
      .delete("/api/v1/auth/sessions")
      .set(...bearer(second.body.data.accessToken as string))
      .expect(200);

    await request(app)
      .get("/api/v1/auth/me")
      .set(...bearer(user.accessToken))
      .expect(401);
  });

  it("does not accept a refresh token as a bearer token", async () => {
    const user = await createUser("Token Confusion");

    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: PASSWORD, rememberMe: false })
      .expect(200);

    const cookie = (login.headers["set-cookie"] as unknown as string[])[0] ?? "";
    const refreshToken = cookie.split(";")[0]?.split("=")[1] ?? "";

    await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${refreshToken}`)
      .expect(401);
  });
});

describe("OpenAPI documentation", () => {
  it("documents every auth route the router actually mounts", async () => {
    const response = await request(app).get("/api/v1/openapi.json").expect(200);
    const paths = Object.keys(response.body.paths as Record<string, unknown>);

    expect(paths).toEqual(
      expect.arrayContaining([
        "/auth/register",
        "/auth/login",
        "/auth/refresh",
        "/auth/logout",
        "/auth/me",
        "/auth/verify-email",
        "/auth/verify-email/resend",
        "/auth/password/forgot",
        "/auth/password/reset",
        "/auth/password/change",
        "/auth/sessions",
        "/auth/sessions/{id}",
        "/auth/2fa/setup",
        "/auth/2fa/confirm",
        "/auth/2fa/disable",
        "/auth/2fa/challenge",
      ]),
    );
  });

  it("declares both the bearer and refresh-cookie security schemes", async () => {
    const response = await request(app).get("/api/v1/openapi.json").expect(200);
    const schemes = response.body.components.securitySchemes as Record<
      string,
      { type: string; in?: string }
    >;

    expect(schemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    expect(schemes.refreshCookie).toMatchObject({ type: "apiKey", in: "cookie" });
  });

  it("documents the AuthUser role enum as the frontend's six values", async () => {
    const response = await request(app).get("/api/v1/openapi.json").expect(200);
    const roles = response.body.components.schemas.AuthUser.properties.role
      .enum as string[];

    expect(roles).toEqual([
      "guest",
      "member",
      "verified_builder",
      "moderator",
      "community_admin",
      "platform_admin",
    ]);
  });

  it("does not document a refreshToken field in any response payload", async () => {
    const response = await request(app).get("/api/v1/openapi.json").expect(200);

    // The refresh token is cookie-only; documenting a body field would invite
    // a client to look for one.
    expect(JSON.stringify(response.body.components.schemas)).not.toContain(
      '"refreshToken"',
    );
  });
});
