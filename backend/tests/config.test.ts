import { describe, expect, it } from "vitest";

import { parseEnv } from "../src/config/env.js";

/**
 * Configuration validation is the difference between "fails at boot with a
 * clear message" and "boots fine, then 500s at 3am". These assert the schema
 * actually rejects the mistakes people really make.
 */

const validEnv = {
  NODE_ENV: "test",
  PORT: "4000",
  CORS_ORIGIN: "http://localhost:3000",
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db?schema=public",
  REDIS_URL: "redis://localhost:6379",
  JWT_ACCESS_SECRET: "a".repeat(32),
  JWT_REFRESH_SECRET: "b".repeat(32),
  TWO_FACTOR_SECRET_KEY: "c".repeat(32),
} satisfies NodeJS.ProcessEnv;

describe("Environment validation", () => {
  it("accepts a complete, valid configuration", () => {
    const parsed = parseEnv(validEnv);

    expect(parsed.PORT).toBe(4000);
    expect(parsed.NODE_ENV).toBe("test");
  });

  it("applies documented defaults for optional values", () => {
    const parsed = parseEnv(validEnv);

    expect(parsed.LOG_LEVEL).toBe("info");
    expect(parsed.BODY_LIMIT).toBe("1mb");
    expect(parsed.RATE_LIMIT_MAX).toBe(100);
  });

  it("defaults the auth lifetimes and cookie policy", () => {
    const parsed = parseEnv(validEnv);

    expect(parsed.JWT_ACCESS_EXPIRES).toBe("15m");
    expect(parsed.JWT_REFRESH_EXPIRES).toBe("7d");
    // "Remember me for 30 days" is what the shipped login form promises.
    expect(parsed.JWT_REFRESH_REMEMBER_EXPIRES).toBe("30d");
    expect(parsed.COOKIE_SAMESITE).toBe("lax");
    expect(parsed.AUTH_COOKIE_PATH).toBe("/api/v1/auth");
    expect(parsed.EMAIL_PROVIDER).toBe("console");
  });

  it("rejects a 2FA encryption key that is too short", () => {
    expect(() => parseEnv({ ...validEnv, TWO_FACTOR_SECRET_KEY: "short" })).toThrow();
  });

  it("rejects the .env.example placeholders for every secret", () => {
    // `cp .env.example .env` must fail fast rather than boot on a signing key
    // and an encryption key that are both published in this repository. The
    // placeholders are >32 chars, so length alone would have accepted them.
    for (const key of [
      "JWT_ACCESS_SECRET",
      "JWT_REFRESH_SECRET",
      "TWO_FACTOR_SECRET_KEY",
    ] as const) {
      expect(() =>
        parseEnv({ ...validEnv, [key]: "replace_me_with_a_long_random_string_min_32" }),
      ).toThrow();
    }
  });

  it("rejects a missing 2FA encryption key rather than defaulting one", () => {
    // A shipped default encryption key would protect nothing, so the schema
    // must refuse to boot without a real value.
    const { TWO_FACTOR_SECRET_KEY: _omitted, ...withoutKey } = validEnv;
    expect(() => parseEnv(withoutKey)).toThrow();
  });

  it("parses COOKIE_SECURE as a real boolean, not Boolean('false')", () => {
    expect(parseEnv({ ...validEnv, COOKIE_SECURE: "false" }).COOKIE_SECURE).toBe(false);
    expect(parseEnv({ ...validEnv, COOKIE_SECURE: "true" }).COOKIE_SECURE).toBe(true);
    expect(parseEnv(validEnv).COOKIE_SECURE).toBeUndefined();
  });

  it("coerces numeric strings, since every env var arrives as a string", () => {
    const parsed = parseEnv({ ...validEnv, PORT: "8080" });

    expect(parsed.PORT).toBe(8080);
    expect(typeof parsed.PORT).toBe("number");
  });

  it("splits a comma-separated CORS allowlist into origins", () => {
    const parsed = parseEnv({
      ...validEnv,
      CORS_ORIGIN: "http://localhost:3000, https://forgehub.example",
    });

    expect(parsed.CORS_ORIGIN).toEqual([
      "http://localhost:3000",
      "https://forgehub.example",
    ]);
  });

  it("rejects a missing database URL", () => {
    const { DATABASE_URL: _omitted, ...withoutDatabase } = validEnv;
    expect(() => parseEnv(withoutDatabase)).toThrow();
  });

  it("rejects a non-postgres database URL", () => {
    // Catches pointing DATABASE_URL at the wrong service entirely.
    expect(() =>
      parseEnv({ ...validEnv, DATABASE_URL: "mysql://user:pass@localhost:3306/db" }),
    ).toThrow();
  });

  it("rejects a JWT secret that is too short to be safe", () => {
    expect(() => parseEnv({ ...validEnv, JWT_ACCESS_SECRET: "short" })).toThrow();
  });

  it("rejects an out-of-range port", () => {
    expect(() => parseEnv({ ...validEnv, PORT: "99999" })).toThrow();
  });

  it("rejects an unknown NODE_ENV", () => {
    expect(() => parseEnv({ ...validEnv, NODE_ENV: "staging" })).toThrow();
  });
});
