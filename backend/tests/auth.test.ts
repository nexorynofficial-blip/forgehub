import { generate as generateTotpCode } from "otplib";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * End-to-end authentication flows against real PostgreSQL and Redis.
 *
 * Mirrors `database.test.ts`: everything created here is namespaced and
 * removed afterwards, so the suite can run repeatedly against a developer's
 * seeded database without disturbing it.
 *
 * Email is the one thing that is faked — not to avoid I/O, but because
 * verification and reset tokens exist only inside the message. The database
 * stores a keyed hash, so capturing the outgoing mail is the only way to
 * exercise the flows a real user would complete.
 */

const { mailbox } = vi.hoisted(() => ({
  mailbox: [] as Array<{
    kind: "verify" | "reset" | "alert";
    to: string;
    token?: string;
    event?: string;
  }>,
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
    sendSecurityAlertEmail: (to: string, o: { event: string }) => {
      mailbox.push({ kind: "alert", to, event: o.event });
      return Promise.resolve();
    },
  },
}));

const { createApp } = await import("../src/app.js");
const { prisma } = await import("../src/database/prisma.js");
const { connectRedis, redis } = await import("../src/config/redis.js");

const app = createApp();

/** Namespace shared by every row this file creates. */
const NS = "authtest";
const PASSWORD = "ValidPass123";
const NEW_PASSWORD = "BrandNewPass456";
const REFRESH_COOKIE = process.env["REFRESH_COOKIE_NAME"] ?? "forgehub_refresh";

let counter = 0;
function uniqueEmail(): string {
  counter += 1;
  return `${NS}.${String(counter)}.${String(Date.now())}@forgehub.test`;
}

function lastMail(kind: "verify" | "reset", to: string): string {
  const entry = [...mailbox].reverse().find((m) => m.kind === kind && m.to === to);
  if (!entry?.token) throw new Error(`No ${kind} email captured for ${to}`);
  return entry.token;
}

/** Pulls the raw refresh token out of a Set-Cookie header. */
function refreshCookieFrom(response: request.Response): string {
  const header = response.headers["set-cookie"] as unknown as string[] | undefined;
  const cookie = header?.find((value) => value.startsWith(`${REFRESH_COOKIE}=`));

  if (!cookie) throw new Error("No refresh cookie was set");
  return cookie.split(";")[0] as string;
}

interface Registered {
  email: string;
  username: string;
  userId: string;
  accessToken: string;
  refreshCookie: string;
}

/** Registers, verifies, and signs in — the starting point for most tests. */
async function createVerifiedUser(displayName = "Auth Tester"): Promise<Registered> {
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

  await request(app)
    .post("/api/v1/auth/verify-email")
    .send({ token: lastMail("verify", email) })
    .expect(200);

  const login = await request(app)
    .post("/api/v1/auth/login")
    .send({ email, password: PASSWORD, rememberMe: false })
    .expect(200);

  return {
    email,
    username: login.body.data.user.username as string,
    userId: login.body.data.user.id as string,
    accessToken: login.body.data.accessToken as string,
    refreshCookie: refreshCookieFrom(login),
  };
}

function bearer(token: string): [string, string] {
  return ["Authorization", `Bearer ${token}`];
}

beforeAll(async () => {
  // The 2FA challenge store and the brute-force counters are real Redis
  // operations, not fail-open reads, so the client has to be connected.
  await connectRedis();
});

afterAll(async () => {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: NS } },
    select: { id: true },
  });
  const ids = users.map((user) => user.id);

  if (ids.length > 0) {
    // Audit rows survive their actor by design (`onDelete: SetNull`), so they
    // have to be cleared explicitly or the table grows every run.
    await prisma.auditLog.deleteMany({
      where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] },
    });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  await prisma.$disconnect();
  await redis.quit();
});

describe("Registration", () => {
  it("creates an account and dispatches a verification email", async () => {
    const email = uniqueEmail();

    const response = await request(app)
      .post("/api/v1/auth/register")
      .send({
        displayName: "Ada Lovelace",
        email,
        password: PASSWORD,
        confirmPassword: PASSWORD,
        agreeToTerms: true,
      })
      .expect(201);

    expect(response.body).toMatchObject({
      success: true,
      error: null,
      data: { email, verificationRequired: true },
    });
    expect(mailbox.some((m) => m.kind === "verify" && m.to === email)).toBe(true);
  });

  it("generates a username from the display name", async () => {
    const user = await createVerifiedUser("Grace Hopper");
    expect(user.username).toMatch(/^grace\.hopper\d*$/);
  });

  it("resolves username collisions with a numeric suffix", async () => {
    const first = await createVerifiedUser("Colliding Name");
    const second = await createVerifiedUser("Colliding Name");
    const third = await createVerifiedUser("Colliding Name");

    const handles = [first.username, second.username, third.username];

    expect(new Set(handles).size).toBe(3);
    for (const handle of handles) {
      expect(handle).toMatch(/^colliding\.name\d*$/);
    }
  });

  it("does not reveal that an email is already registered", async () => {
    const email = uniqueEmail();
    const payload = {
      displayName: "First Owner",
      email,
      password: PASSWORD,
      confirmPassword: PASSWORD,
      agreeToTerms: true,
    };

    const first = await request(app)
      .post("/api/v1/auth/register")
      .send(payload)
      .expect(201);

    const second = await request(app)
      .post("/api/v1/auth/register")
      .send({ ...payload, displayName: "Second Owner" })
      .expect(201);

    // Byte-identical: the response is not an account-existence oracle.
    expect(second.body).toEqual(first.body);

    // …and crucially, no second account was actually created.
    const count = await prisma.user.count({ where: { email } });
    expect(count).toBe(1);
  });

  it("enforces the frontend's own password rules server-side", async () => {
    const weak = await request(app)
      .post("/api/v1/auth/register")
      .send({
        displayName: "Weak Password",
        email: uniqueEmail(),
        password: "short",
        confirmPassword: "short",
        agreeToTerms: true,
      })
      .expect(422);

    expect(weak.body.error.code).toBe("VALIDATION_ERROR");
    expect(weak.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "body.password" })]),
    );
  });

  it("rejects mismatched confirmation and unaccepted terms", async () => {
    await request(app)
      .post("/api/v1/auth/register")
      .send({
        displayName: "Mismatch",
        email: uniqueEmail(),
        password: PASSWORD,
        confirmPassword: "SomethingElse123",
        agreeToTerms: true,
      })
      .expect(422);

    await request(app)
      .post("/api/v1/auth/register")
      .send({
        displayName: "No Terms",
        email: uniqueEmail(),
        password: PASSWORD,
        confirmPassword: PASSWORD,
        agreeToTerms: false,
      })
      .expect(422);
  });

  it("records terms acceptance in the audit log", async () => {
    const user = await createVerifiedUser("Terms Accepter");

    const entry = await prisma.auditLog.findFirst({
      where: { actorId: user.userId, action: "TERMS_ACCEPTED" },
    });

    expect(entry).not.toBeNull();
  });
});

describe("Email verification", () => {
  it("verifies an address with the emailed token", async () => {
    const email = uniqueEmail();

    await request(app)
      .post("/api/v1/auth/register")
      .send({
        displayName: "Verify Me",
        email,
        password: PASSWORD,
        confirmPassword: PASSWORD,
        agreeToTerms: true,
      })
      .expect(201);

    const response = await request(app)
      .post("/api/v1/auth/verify-email")
      .send({ token: lastMail("verify", email) })
      .expect(200);

    expect(response.body.data.user.emailVerified).toBe(true);
  });

  it("refuses to reuse a verification token", async () => {
    const email = uniqueEmail();

    await request(app)
      .post("/api/v1/auth/register")
      .send({
        displayName: "Single Use",
        email,
        password: PASSWORD,
        confirmPassword: PASSWORD,
        agreeToTerms: true,
      })
      .expect(201);

    const token = lastMail("verify", email);

    await request(app).post("/api/v1/auth/verify-email").send({ token }).expect(200);
    await request(app).post("/api/v1/auth/verify-email").send({ token }).expect(422);
  });

  it("rejects an unknown token", async () => {
    await request(app)
      .post("/api/v1/auth/verify-email")
      .send({ token: "a".repeat(43) })
      .expect(422);
  });

  it("responds identically to a resend for a real and an unknown address", async () => {
    const user = await createVerifiedUser("Resend Target");

    const known = await request(app)
      .post("/api/v1/auth/verify-email/resend")
      .send({ email: user.email })
      .expect(200);

    const unknown = await request(app)
      .post("/api/v1/auth/verify-email/resend")
      .send({ email: `${NS}.nobody@forgehub.test` })
      .expect(200);

    expect(unknown.body).toEqual(known.body);
  });
});

describe("Login", () => {
  it("returns an access token and sets an httpOnly refresh cookie", async () => {
    const user = await createVerifiedUser("Login Target");

    const response = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: PASSWORD, rememberMe: false })
      .expect(200);

    expect(response.body.data.accessToken).toEqual(expect.any(String));
    expect(response.body.data.user.email).toBe(user.email);

    const cookie = (response.headers["set-cookie"] as unknown as string[]).find((c) =>
      c.startsWith(`${REFRESH_COOKIE}=`),
    );

    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/api/v1/auth");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("never puts the refresh token in the response body", async () => {
    const user = await createVerifiedUser("Body Check");

    const response = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: PASSWORD, rememberMe: false })
      .expect(200);

    const cookieValue = refreshCookieFrom(response).split("=")[1] as string;
    const body = JSON.stringify(response.body);

    expect(body).not.toContain(cookieValue);
    expect(response.body.data).not.toHaveProperty("refreshToken");
  });

  it("honours rememberMe with a longer cookie lifetime", async () => {
    const user = await createVerifiedUser("Remember Me");

    const [short, long] = await Promise.all([
      request(app)
        .post("/api/v1/auth/login")
        .send({ email: user.email, password: PASSWORD, rememberMe: false }),
      request(app)
        .post("/api/v1/auth/login")
        .send({ email: user.email, password: PASSWORD, rememberMe: true }),
    ]);

    // 7 days vs the 30 the login form promises.
    expect(short.body.data.expiresIn).toBe(604_800_000);
    expect(long.body.data.expiresIn).toBe(2_592_000_000);
  });

  it("rejects a wrong password with a generic message", async () => {
    const user = await createVerifiedUser("Wrong Password");

    const response = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: "TotallyWrong123", rememberMe: false })
      .expect(401);

    expect(response.body.error.code).toBe("AUTHENTICATION_ERROR");
    expect(response.body.error.message).toBe("Invalid email or password");
  });

  it("answers an unknown email exactly as it answers a wrong password", async () => {
    const user = await createVerifiedUser("Enumeration Target");

    const wrongPassword = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: "TotallyWrong123", rememberMe: false })
      .expect(401);

    const unknownEmail = await request(app)
      .post("/api/v1/auth/login")
      .send({
        email: `${NS}.ghost@forgehub.test`,
        password: "TotallyWrong123",
        rememberMe: false,
      })
      .expect(401);

    expect(unknownEmail.body).toEqual(wrongPassword.body);
  });

  it("refuses a banned account even with the correct password", async () => {
    const user = await createVerifiedUser("Banned User");
    await prisma.user.update({
      where: { id: user.userId },
      data: { status: "banned" },
    });

    const response = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: PASSWORD, rememberMe: false })
      .expect(403);

    expect(response.body.error.code).toBe("AUTHORIZATION_ERROR");
  });

  it("refuses a soft-deleted account", async () => {
    const user = await createVerifiedUser("Deleted User");
    await prisma.user.update({
      where: { id: user.userId },
      data: { deletedAt: new Date() },
    });

    await request(app)
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: PASSWORD, rememberMe: false })
      .expect(401);
  });
});

describe("Current user", () => {
  it("returns the authenticated user", async () => {
    const user = await createVerifiedUser("Me Endpoint");

    const response = await request(app)
      .get("/api/v1/auth/me")
      .set(...bearer(user.accessToken))
      .expect(200);

    expect(response.body.data.user).toMatchObject({
      id: user.userId,
      email: user.email,
      role: "member",
      status: "active",
      twoFactorEnabled: false,
    });
  });

  it("rejects a missing or malformed token", async () => {
    await request(app).get("/api/v1/auth/me").expect(401);
    await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", "Bearer nonsense")
      .expect(401);
    await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", "Basic abc123")
      .expect(401);
  });
});

describe("Refresh rotation", () => {
  it("rotates the refresh token and issues a new access token", async () => {
    const user = await createVerifiedUser("Rotation");

    const response = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", user.refreshCookie)
      .expect(200);

    expect(response.body.data.accessToken).toEqual(expect.any(String));
    expect(refreshCookieFrom(response)).not.toBe(user.refreshCookie);
  });

  it("rejects the previous refresh token once it has been rotated away", async () => {
    const user = await createVerifiedUser("Old Token");

    await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", user.refreshCookie)
      .expect(200);

    await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", user.refreshCookie)
      .expect(401);
  });

  it("treats reuse of a rotated token as theft and kills the whole session", async () => {
    const user = await createVerifiedUser("Reuse Detection");

    const rotated = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", user.refreshCookie)
      .expect(200);

    const currentCookie = refreshCookieFrom(rotated);

    // Replaying the retired token is the signal that it leaked.
    await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", user.refreshCookie)
      .expect(401);

    // The legitimate client's *current* token must now be dead too — that is
    // the whole point of revoking the family rather than just the old token.
    await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", currentCookie)
      .expect(401);

    const audit = await prisma.auditLog.findFirst({
      where: { actorId: user.userId, action: "REFRESH_TOKEN_REUSE_DETECTED" },
    });
    expect(audit).not.toBeNull();
  });

  it("rejects a refresh attempt with no cookie at all", async () => {
    await request(app).post("/api/v1/auth/refresh").expect(401);
  });

  it("stops refreshing once the session is revoked", async () => {
    const user = await createVerifiedUser("Revoked Session");

    await request(app)
      .post("/api/v1/auth/logout")
      .set("Cookie", user.refreshCookie)
      .expect(200);

    await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", user.refreshCookie)
      .expect(401);
  });
});

describe("Logout", () => {
  it("revokes the session and immediately invalidates the access token", async () => {
    const user = await createVerifiedUser("Logout");

    await request(app)
      .get("/api/v1/auth/me")
      .set(...bearer(user.accessToken))
      .expect(200);

    await request(app)
      .post("/api/v1/auth/logout")
      .set("Cookie", user.refreshCookie)
      .expect(200);

    // Not "until the JWT expires" — the session check makes it immediate.
    await request(app)
      .get("/api/v1/auth/me")
      .set(...bearer(user.accessToken))
      .expect(401);
  });

  it("succeeds even without a valid token, and clears the cookie", async () => {
    const response = await request(app).post("/api/v1/auth/logout").expect(200);

    expect(response.body.data.signedOut).toBe(true);
    expect(response.headers["set-cookie"]).toBeDefined();
  });

  it("signs out a bearer-only client that holds no cookie", async () => {
    const user = await createVerifiedUser("Bearer Logout");

    // A native client has an access token and no cookie jar. Reporting
    // success while leaving the session alive would be the worst outcome.
    await request(app)
      .post("/api/v1/auth/logout")
      .set(...bearer(user.accessToken))
      .expect(200);

    await request(app)
      .get("/api/v1/auth/me")
      .set(...bearer(user.accessToken))
      .expect(401);
  });
});

describe("Password reset", () => {
  it("completes a reset and swaps the working password", async () => {
    const user = await createVerifiedUser("Reset Flow");

    await request(app)
      .post("/api/v1/auth/password/forgot")
      .send({ email: user.email })
      .expect(200);

    await request(app)
      .post("/api/v1/auth/password/reset")
      .send({
        token: lastMail("reset", user.email),
        password: NEW_PASSWORD,
        confirmPassword: NEW_PASSWORD,
      })
      .expect(200);

    await request(app)
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: PASSWORD, rememberMe: false })
      .expect(401);

    await request(app)
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: NEW_PASSWORD, rememberMe: false })
      .expect(200);
  });

  it("revokes every existing session", async () => {
    const user = await createVerifiedUser("Reset Revokes");

    await request(app)
      .post("/api/v1/auth/password/forgot")
      .send({ email: user.email })
      .expect(200);

    await request(app)
      .post("/api/v1/auth/password/reset")
      .send({
        token: lastMail("reset", user.email),
        password: NEW_PASSWORD,
        confirmPassword: NEW_PASSWORD,
      })
      .expect(200);

    await request(app)
      .get("/api/v1/auth/me")
      .set(...bearer(user.accessToken))
      .expect(401);
  });

  it("refuses to reuse a reset token", async () => {
    const user = await createVerifiedUser("Reset Single Use");

    await request(app)
      .post("/api/v1/auth/password/forgot")
      .send({ email: user.email })
      .expect(200);

    const token = lastMail("reset", user.email);

    await request(app)
      .post("/api/v1/auth/password/reset")
      .send({ token, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD })
      .expect(200);

    await request(app)
      .post("/api/v1/auth/password/reset")
      .send({ token, password: "YetAnother789", confirmPassword: "YetAnother789" })
      .expect(422);
  });

  it("responds identically for a known and an unknown address", async () => {
    const user = await createVerifiedUser("Forgot Enumeration");

    const known = await request(app)
      .post("/api/v1/auth/password/forgot")
      .send({ email: user.email })
      .expect(200);

    const unknown = await request(app)
      .post("/api/v1/auth/password/forgot")
      .send({ email: `${NS}.nowhere@forgehub.test` })
      .expect(200);

    expect(unknown.body).toEqual(known.body);
  });
});

describe("Password change", () => {
  it("changes the password and keeps the caller signed in", async () => {
    const user = await createVerifiedUser("Change Password");

    await request(app)
      .post("/api/v1/auth/password/change")
      .set(...bearer(user.accessToken))
      .send({
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmNewPassword: NEW_PASSWORD,
      })
      .expect(200);

    // The tab that made the change stays usable…
    await request(app)
      .get("/api/v1/auth/me")
      .set(...bearer(user.accessToken))
      .expect(200);

    await request(app)
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: NEW_PASSWORD, rememberMe: false })
      .expect(200);
  });

  it("signs other devices out", async () => {
    const user = await createVerifiedUser("Change Revokes Others");

    const other = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: PASSWORD, rememberMe: false })
      .expect(200);

    await request(app)
      .post("/api/v1/auth/password/change")
      .set(...bearer(user.accessToken))
      .send({
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmNewPassword: NEW_PASSWORD,
      })
      .expect(200);

    // …but the other device is gone.
    await request(app)
      .get("/api/v1/auth/me")
      .set(...bearer(other.body.data.accessToken as string))
      .expect(401);
  });

  it("requires the correct current password", async () => {
    const user = await createVerifiedUser("Wrong Current");

    await request(app)
      .post("/api/v1/auth/password/change")
      .set(...bearer(user.accessToken))
      .send({
        currentPassword: "NotMyPassword1",
        newPassword: NEW_PASSWORD,
        confirmNewPassword: NEW_PASSWORD,
      })
      .expect(401);
  });
});

describe("Sessions", () => {
  it("lists active sessions and flags the current one", async () => {
    const user = await createVerifiedUser("Session List");

    await request(app)
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: PASSWORD, rememberMe: false })
      .expect(200);

    const response = await request(app)
      .get("/api/v1/auth/sessions")
      .set(...bearer(user.accessToken))
      .expect(200);

    const sessions = response.body.data.sessions as Array<{ current: boolean }>;

    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions.filter((session) => session.current)).toHaveLength(1);
  });

  it("revokes a single session", async () => {
    const user = await createVerifiedUser("Session Revoke");

    const other = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: PASSWORD, rememberMe: false })
      .expect(200);

    const list = await request(app)
      .get("/api/v1/auth/sessions")
      .set(...bearer(user.accessToken))
      .expect(200);

    const target = (
      list.body.data.sessions as Array<{ id: string; current: boolean }>
    ).find((session) => !session.current);

    await request(app)
      .delete(`/api/v1/auth/sessions/${target?.id ?? ""}`)
      .set(...bearer(user.accessToken))
      .expect(200);

    await request(app)
      .get("/api/v1/auth/me")
      .set(...bearer(other.body.data.accessToken as string))
      .expect(401);
  });

  it("revokes every other session at once", async () => {
    const user = await createVerifiedUser("Revoke Others");

    const other = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: PASSWORD, rememberMe: false })
      .expect(200);

    const response = await request(app)
      .delete("/api/v1/auth/sessions")
      .set(...bearer(user.accessToken))
      .expect(200);

    expect(response.body.data.revoked).toBeGreaterThanOrEqual(1);

    await request(app)
      .get("/api/v1/auth/me")
      .set(...bearer(other.body.data.accessToken as string))
      .expect(401);
    await request(app)
      .get("/api/v1/auth/me")
      .set(...bearer(user.accessToken))
      .expect(200);
  });
});

describe("Two-factor authentication", () => {
  /** Enrols a fresh user and returns their TOTP secret and backup codes. */
  async function enroll(displayName: string): Promise<{
    user: Registered;
    secret: string;
    backupCodes: string[];
  }> {
    const user = await createVerifiedUser(displayName);

    const setup = await request(app)
      .post("/api/v1/auth/2fa/setup")
      .set(...bearer(user.accessToken))
      .expect(200);

    const secret = setup.body.data.secret as string;

    const confirm = await request(app)
      .post("/api/v1/auth/2fa/confirm")
      .set(...bearer(user.accessToken))
      .send({ code: await generateTotpCode({ secret }) })
      .expect(200);

    return { user, secret, backupCodes: confirm.body.data.backupCodes as string[] };
  }

  it("returns enrollment material a QR code can be built from", async () => {
    const user = await createVerifiedUser("2FA Setup");

    const response = await request(app)
      .post("/api/v1/auth/2fa/setup")
      .set(...bearer(user.accessToken))
      .expect(200);

    expect(response.body.data.secret).toEqual(expect.any(String));
    expect(response.body.data.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(response.body.data.otpauthUrl).toContain("ForgeHub");
  });

  it("stores the secret encrypted, not in plaintext", async () => {
    const user = await createVerifiedUser("2FA Encrypted");

    const setup = await request(app)
      .post("/api/v1/auth/2fa/setup")
      .set(...bearer(user.accessToken))
      .expect(200);

    const stored = await prisma.twoFactorCredential.findUnique({
      where: { userId: user.userId },
    });

    expect(stored?.secret).not.toBe(setup.body.data.secret);
    expect(stored?.secret).toMatch(/^v1\./);
    expect(stored?.enabled).toBe(false);
  });

  it("confirms enrollment with a valid code and returns backup codes", async () => {
    const { backupCodes } = await enroll("2FA Confirm");

    expect(backupCodes).toHaveLength(10);
    expect(new Set(backupCodes).size).toBe(10);
  });

  it("rejects an invalid confirmation code and stays disabled", async () => {
    const user = await createVerifiedUser("2FA Bad Confirm");

    await request(app)
      .post("/api/v1/auth/2fa/setup")
      .set(...bearer(user.accessToken))
      .expect(200);

    await request(app)
      .post("/api/v1/auth/2fa/confirm")
      .set(...bearer(user.accessToken))
      .send({ code: "000000" })
      .expect(422);

    const stored = await prisma.twoFactorCredential.findUnique({
      where: { userId: user.userId },
    });
    expect(stored?.enabled).toBe(false);
  });

  it("stops issuing tokens at login once 2FA is on", async () => {
    const { user } = await enroll("2FA Login Challenge");

    const response = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: PASSWORD, rememberMe: false })
      .expect(200);

    expect(response.body.data.twoFactorRequired).toBe(true);
    expect(response.body.data).not.toHaveProperty("accessToken");
  });

  it("completes the challenge with a valid TOTP code", async () => {
    const { user, secret } = await enroll("2FA Challenge Success");

    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: PASSWORD, rememberMe: false })
      .expect(200);

    const response = await request(app)
      .post("/api/v1/auth/2fa/challenge")
      .send({
        challengeToken: login.body.data.challengeToken as string,
        code: await generateTotpCode({ secret }),
      })
      .expect(200);

    expect(response.body.data.accessToken).toEqual(expect.any(String));
    expect(refreshCookieFrom(response)).toBeTruthy();
  });

  it("rejects an invalid TOTP code at the challenge", async () => {
    const { user } = await enroll("2FA Challenge Failure");

    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: PASSWORD, rememberMe: false })
      .expect(200);

    await request(app)
      .post("/api/v1/auth/2fa/challenge")
      .send({
        challengeToken: login.body.data.challengeToken as string,
        code: "000000",
      })
      .expect(401);
  });

  it("accepts a backup code, and only once", async () => {
    const { user, backupCodes } = await enroll("2FA Backup Code");
    const code = backupCodes[0] as string;

    const first = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: PASSWORD, rememberMe: false })
      .expect(200);

    await request(app)
      .post("/api/v1/auth/2fa/challenge")
      .send({
        challengeToken: first.body.data.challengeToken as string,
        backupCode: code,
      })
      .expect(200);

    const second = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: PASSWORD, rememberMe: false })
      .expect(200);

    // Single-use: the same code must not open a second door.
    await request(app)
      .post("/api/v1/auth/2fa/challenge")
      .send({
        challengeToken: second.body.data.challengeToken as string,
        backupCode: code,
      })
      .expect(401);
  });

  it("resolves the challenge from the cookie when the body omits it", async () => {
    const { user, secret } = await enroll("2FA Cookie Challenge");
    const agent = request.agent(app);

    await agent
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: PASSWORD, rememberMe: false })
      .expect(200);

    const response = await agent
      .post("/api/v1/auth/2fa/challenge")
      .send({ code: await generateTotpCode({ secret }) })
      .expect(200);

    expect(response.body.data.accessToken).toEqual(expect.any(String));
  });

  it("rejects a challenge with neither a code nor a backup code", async () => {
    const { user } = await enroll("2FA Empty Challenge");

    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: PASSWORD, rememberMe: false })
      .expect(200);

    await request(app)
      .post("/api/v1/auth/2fa/challenge")
      .send({ challengeToken: login.body.data.challengeToken as string })
      .expect(422);
  });

  it("requires the password to disable, then restores password-only login", async () => {
    const { user } = await enroll("2FA Disable");

    await request(app)
      .post("/api/v1/auth/2fa/disable")
      .set(...bearer(user.accessToken))
      .send({ password: "WrongPassword1" })
      .expect(401);

    await request(app)
      .post("/api/v1/auth/2fa/disable")
      .set(...bearer(user.accessToken))
      .send({ password: PASSWORD })
      .expect(200);

    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: PASSWORD, rememberMe: false })
      .expect(200);

    expect(login.body.data.accessToken).toEqual(expect.any(String));
  });

  it("refuses to start enrollment twice while enabled", async () => {
    const { user } = await enroll("2FA Double Enroll");

    await request(app)
      .post("/api/v1/auth/2fa/setup")
      .set(...bearer(user.accessToken))
      .expect(409);
  });
});
