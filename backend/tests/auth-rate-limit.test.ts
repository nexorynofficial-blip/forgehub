import request from "supertest";
import { describe, expect, it, vi } from "vitest";

/**
 * HTTP rate limiting on the credential routes (BACKEND_ARCHITECTURE.md §28).
 *
 * This budgets requests per *source address*. The per-account lockout is a
 * separate mechanism with its own suite (`auth-brute-force.test.ts`) — both
 * answer 429, so each file disables the other's threshold to keep the cause
 * of any 429 unambiguous.
 */

// Assigned before `config/env` is imported below, and deliberately not via
// `fallback()` — this file needs a small budget where every other suite needs
// it out of the way.
process.env["RATE_LIMIT_MAX"] = "100000";
process.env["AUTH_RATE_LIMIT_MAX"] = "8";
process.env["AUTH_RATE_LIMIT_WINDOW_MS"] = "60000";
/** Effectively disabled here, so only the rate limiter can produce a 429. */
process.env["AUTH_BRUTE_FORCE_MAX_ATTEMPTS"] = "100000";

vi.mock("../src/integrations/email/index.js", () => ({
  emailService: {
    providerName: "test",
    sendVerificationEmail: () => Promise.resolve(),
    sendPasswordResetEmail: () => Promise.resolve(),
    sendSecurityAlertEmail: () => Promise.resolve(),
  },
}));

vi.mock("../src/database/prisma.js", () => ({
  // No account has to exist for a rate-limit test: the limiter runs before
  // the controller, so every request can take the unknown-email path.
  prisma: {},
  checkDatabaseConnection: vi.fn().mockResolvedValue(true),
  connectDatabase: vi.fn(),
  disconnectDatabase: vi.fn(),
}));

vi.mock("../src/config/redis.js", () => ({
  redis: {
    call: vi.fn(),
    ttl: vi.fn().mockResolvedValue(-2),
    incr: vi.fn(),
    del: vi.fn(),
  },
  createRedisClient: vi.fn(),
  connectRedis: vi.fn(),
  disconnectRedis: vi.fn(),
  checkRedisConnection: vi.fn().mockResolvedValue(true),
}));

const { createApp } = await import("../src/app.js");

/** Separate instances: the in-memory store is created per `createApp()`. */
const rateLimitApp = createApp();
const bystanderApp = createApp();

function login(app: ReturnType<typeof createApp>, email: string) {
  return request(app)
    .post("/api/v1/auth/login")
    .send({ email, password: "WrongPassword1", rememberMe: false });
}

describe("Credential rate limiting", () => {
  it("throttles the source once the request budget is spent", async () => {
    let limited: request.Response | null = null;
    let allowed = 0;

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await login(rateLimitApp, `rl${String(attempt)}@forgehub.test`);

      if (response.status === 429) {
        limited = response;
        break;
      }
      allowed += 1;
    }

    expect(allowed).toBe(8);
    expect(limited?.body.error.code).toBe("RATE_LIMITED");
    expect(limited?.body.success).toBe(false);
    expect(limited?.body.data).toBeNull();
  });

  it("advertises the budget through standard rate-limit headers", async () => {
    const response = await login(bystanderApp, "headers@forgehub.test");

    // draft-7 combined header, as configured in the limiter.
    expect(
      response.headers["ratelimit"] ?? response.headers["ratelimit-limit"],
    ).toBeDefined();
  });

  it("shares one budget across the whole credential surface", async () => {
    // register/login/forgot all mount the same limiter instance, so an
    // attacker cannot reset their allowance by switching endpoints.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await request(bystanderApp)
        .post("/api/v1/auth/password/forgot")
        .send({ email: `spread${String(attempt)}@forgehub.test` });
    }

    const response = await login(bystanderApp, "spread-final@forgehub.test");
    expect(response.status).toBe(429);
  });

  it("leaves non-credential routes reachable", async () => {
    // Exhausting the credential budget must not take the rest of the API
    // down — health probes especially, or an orchestrator would restart us.
    await request(rateLimitApp).get("/api/v1").expect(200);
    await request(rateLimitApp).get("/health").expect(200);
    await request(rateLimitApp).get("/ready").expect(200);
  });
});
