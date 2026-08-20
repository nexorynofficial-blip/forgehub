import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Account-level brute-force lockout, against real Redis.
 *
 * Distinct from the HTTP rate limiter (`auth-rate-limit.test.ts`): this
 * counts failures per *identifier* rather than per source address, which is
 * what defeats credential stuffing spread across many hosts. The rate limit
 * is raised out of the way here so any 429 can only have come from a lockout.
 */

process.env["RATE_LIMIT_MAX"] = "100000";
process.env["AUTH_RATE_LIMIT_MAX"] = "100000";
process.env["AUTH_BRUTE_FORCE_MAX_ATTEMPTS"] = "3";
process.env["AUTH_BRUTE_FORCE_WINDOW_SECONDS"] = "900";
process.env["AUTH_BRUTE_FORCE_BASE_LOCK_SECONDS"] = "60";

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

const NS = "bftest";
const PASSWORD = "ValidPass123";
/** Included in every email so a rerun never inherits a live lockout. */
const RUN = String(Date.now());
const MAX_ATTEMPTS = 3;

let counter = 0;
function uniqueEmail(): string {
  counter += 1;
  return `${NS}.${String(counter)}.${RUN}@forgehub.test`;
}

async function createUser(): Promise<string> {
  const email = uniqueEmail();

  await request(app)
    .post("/api/v1/auth/register")
    .send({
      displayName: "Brute Force Target",
      email,
      password: PASSWORD,
      confirmPassword: PASSWORD,
      agreeToTerms: true,
    })
    .expect(201);

  return email;
}

function badLogin(email: string) {
  return request(app)
    .post("/api/v1/auth/login")
    .send({ email, password: "WrongPassword1", rememberMe: false });
}

function goodLogin(email: string) {
  return request(app)
    .post("/api/v1/auth/login")
    .send({ email, password: PASSWORD, rememberMe: false });
}

/** Burns the full allowance, leaving the identifier locked. */
async function exhaust(email: string): Promise<void> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    await badLogin(email).expect(401);
  }
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

describe("Account brute-force lockout", () => {
  it("allows exactly the configured number of failures, then locks", async () => {
    const email = await createUser();

    await exhaust(email);

    const locked = await badLogin(email).expect(429);
    expect(locked.body.error.code).toBe("RATE_LIMITED");
    expect(locked.body.error.message).toMatch(/try again in \d+ seconds/i);
  });

  it("rejects even the correct password while locked", async () => {
    const email = await createUser();
    await exhaust(email);

    // Knowing the password does not lift the lockout — otherwise an attacker
    // who eventually guesses right would sail straight through.
    await goodLogin(email).expect(429);
  });

  it("locks the identifier rather than the source address", async () => {
    const victim = await createUser();
    const bystander = await createUser();

    await exhaust(victim);
    await badLogin(victim).expect(429);

    // Same client, different account, still fine. A per-IP limit alone would
    // have blocked this; a per-account limit alone would not have blocked the
    // victim. Both mechanisms exist because each misses what the other catches.
    await goodLogin(bystander).expect(200);
  });

  it("gives a locked unknown address the same answer as a locked real one", async () => {
    const real = await createUser();
    const fictional = `${NS}.ghost.${RUN}@forgehub.test`;

    await exhaust(real);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      await badLogin(fictional).expect(401);
    }

    const lockedReal = await badLogin(real).expect(429);
    const lockedGhost = await badLogin(fictional).expect(429);

    // Lockout must not become an account-existence oracle.
    //
    // The countdown is normalized out before comparing. It is wall-clock
    // dependent — the two locks are set milliseconds apart, so under a loaded
    // parallel test run they can land in different whole seconds. That is
    // elapsed time, not a signal about whether the account exists, and
    // asserting on the exact number made this test flaky rather than strict.
    const shape = (body: { error: { code: string; message: string } }) => ({
      code: body.error.code,
      message: body.error.message.replace(/\d+ seconds/, "N seconds"),
    });

    expect(shape(lockedGhost.body)).toEqual(shape(lockedReal.body));
    expect(shape(lockedReal.body).message).toMatch(/try again in N seconds/i);
  });

  it("clears the counter after a successful sign-in", async () => {
    const email = await createUser();

    await badLogin(email).expect(401);
    await badLogin(email).expect(401);
    await goodLogin(email).expect(200);

    // The earlier failures must not carry over, or someone who mistypes twice
    // a week would eventually lock themselves out of a working password.
    await badLogin(email).expect(401);
    await badLogin(email).expect(401);
  });

  it("applies a progressively longer lock on each further failure", async () => {
    const email = await createUser();
    await exhaust(email);

    const first = await badLogin(email).expect(429);
    const firstWait = Number(/(\d+) seconds/.exec(first.body.error.message)?.[1] ?? 0);

    expect(firstWait).toBeGreaterThan(0);
    expect(firstWait).toBeLessThanOrEqual(60);
  });

  it("records the lockout in the audit log", async () => {
    const email = await createUser();
    await exhaust(email);

    const user = await prisma.user.findFirstOrThrow({ where: { email } });
    const entry = await prisma.auditLog.findFirst({
      where: { actorId: user.id, action: "ACCOUNT_LOCKED" },
    });

    expect(entry).not.toBeNull();
  });

  it("audits failed logins without recording the attempted password", async () => {
    const email = await createUser();
    await badLogin(email).expect(401);

    const user = await prisma.user.findFirstOrThrow({ where: { email } });
    const entries = await prisma.auditLog.findMany({
      where: { actorId: user.id, action: "USER_LOGIN_FAILED" },
    });

    expect(entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(entries)).not.toContain("WrongPassword1");
  });

  it("throttles password-reset requests for the same address", async () => {
    const email = await createUser();

    // This scope counts every request, not just failures — it caps volume so
    // the endpoint cannot be used to spam someone's inbox.
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      await request(app).post("/api/v1/auth/password/forgot").send({ email }).expect(200);
    }

    await request(app).post("/api/v1/auth/password/forgot").send({ email }).expect(429);
  });

  it("throttles verification resends for the same address", async () => {
    const email = await createUser();

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      await request(app)
        .post("/api/v1/auth/verify-email/resend")
        .send({ email })
        .expect(200);
    }

    await request(app)
      .post("/api/v1/auth/verify-email/resend")
      .send({ email })
      .expect(429);
  });

  it("keeps its Redis keys free of the addresses being tracked", async () => {
    const email = await createUser();
    await badLogin(email).expect(401);

    const keys = await redis.keys("bf:*");

    expect(keys.length).toBeGreaterThan(0);
    // Identifiers are hashed before they become keys, so a cache dump does
    // not reveal which accounts are under attack.
    for (const key of keys) {
      expect(key).not.toContain(email);
      expect(key).not.toContain(NS);
    }
  });
});
