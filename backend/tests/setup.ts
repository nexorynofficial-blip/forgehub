import { config as loadDotenv } from "dotenv";

/**
 * Test environment bootstrap.
 *
 * Runs before any module that imports `config/env`, which validates on import
 * and calls `process.exit(1)` when required vars are missing.
 *
 * Two kinds of suite share this setup:
 *   - HTTP/unit suites mock Prisma and Redis, so their connection strings are
 *     never dialed and any syntactically valid value will do.
 *   - `database.test.ts` talks to a real PostgreSQL instance.
 *
 * So real values from `.env` win when present, and the placeholders below are
 * only a fallback that keeps the mocked suites runnable without any local
 * infrastructure at all.
 */

loadDotenv();

function fallback(key: string, value: string): void {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}

process.env["NODE_ENV"] = "test";
process.env["LOG_LEVEL"] = "silent";

fallback("PORT", "4001");
fallback("CORS_ORIGIN", "http://localhost:3000");
fallback(
  "DATABASE_URL",
  "postgresql://forgehub:forgehub_dev_password@localhost:5433/forgehub?schema=public",
);
fallback("REDIS_URL", "redis://localhost:6379");
fallback("JWT_ACCESS_SECRET", "test_access_secret_at_least_32_characters_long");
fallback("JWT_REFRESH_SECRET", "test_refresh_secret_at_least_32_characters_long");
fallback("TWO_FACTOR_SECRET_KEY", "test_two_factor_key_at_least_32_characters_long");

/**
 * Assigned unconditionally, unlike the fallbacks above. Auth integration
 * suites make many deliberate credential failures in a row; inheriting the
 * developer's real limits from `.env` would trip the rate limiter or the
 * lockout mid-suite and fail unrelated assertions. The suites that actually
 * exercise those defenses override these again, per file, before importing
 * the app.
 */
process.env["RATE_LIMIT_MAX"] = "100000";
process.env["AUTH_RATE_LIMIT_MAX"] = "100000";
process.env["AUTH_BRUTE_FORCE_MAX_ATTEMPTS"] = "100000";
