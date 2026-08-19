import { env } from "../config/env.js";
import { redis } from "../config/redis.js";
import { AppError } from "./errors.js";
import { logger } from "./logger.js";
import { hashToken } from "./tokens.js";

/**
 * Account-level brute-force protection (BACKEND_TRD.md §17).
 *
 * Deliberately a *separate concept* from the HTTP rate limiter:
 *
 *   - `rate-limit.middleware.ts` throttles a **source** (an IP) across a
 *     route, and is about traffic shaping.
 *   - This throttles an **identifier** (an email, a user id) across every
 *     source, and is about credential stuffing — an attacker spreading
 *     guesses over a botnet defeats the former but not the latter.
 *
 * State lives in Redis, not Postgres: no `failedLoginAttempts` column exists,
 * adding one would need a migration, and short-lived counters are exactly
 * what BACKEND_ARCHITECTURE.md §19 nominates Redis for.
 */

export type BruteForceScope =
  "login" | "register" | "password-reset" | "email-verification" | "two-factor";

/**
 * Identifiers are hashed before they become Redis keys, so a dump of the
 * cache does not reveal which email addresses have been attempting to log in.
 */
function keysFor(
  scope: BruteForceScope,
  identifier: string,
): {
  attempts: string;
  lock: string;
} {
  const digest = hashToken(`bf:${scope}:${identifier.trim().toLowerCase()}`);
  return { attempts: `bf:${scope}:${digest}:n`, lock: `bf:${scope}:${digest}:lock` };
}

/**
 * Lock duration doubles with each failure at or past the threshold, capped.
 *
 * With the default of 5: failures 1–4 are free, the 5th applies a 60s lock,
 * the 6th 120s, the 7th 240s… So "max attempts" means exactly what it says —
 * the 5th wrong password is the last one the caller gets to make.
 */
function lockSecondsFor(attempts: number): number {
  const excess = attempts - env.AUTH_BRUTE_FORCE_MAX_ATTEMPTS + 1;
  if (excess <= 0) return 0;

  const seconds = env.AUTH_BRUTE_FORCE_BASE_LOCK_SECONDS * 2 ** (excess - 1);
  return Math.min(seconds, env.AUTH_BRUTE_FORCE_MAX_LOCK_SECONDS);
}

/**
 * Throws when the identifier is currently locked out.
 *
 * The thrown message never distinguishes a real account from an unknown one —
 * an attacker probing for valid emails learns nothing from a lockout, because
 * failures are counted against whatever was submitted.
 *
 * Fails **open** if Redis is unreachable, matching the rate limiter's
 * `passOnStoreError`: losing the cache should degrade a defense, not lock
 * every user out of the product.
 */
export async function assertNotLockedOut(
  scope: BruteForceScope,
  identifier: string,
): Promise<void> {
  const { lock } = keysFor(scope, identifier);

  let ttl: number;
  try {
    ttl = await redis.ttl(lock);
  } catch (error) {
    logger.warn({ err: error, scope }, "Brute-force check skipped — Redis unavailable");
    return;
  }

  if (ttl > 0) {
    throw AppError.rateLimited(
      `Too many attempts. Please try again in ${String(ttl)} seconds.`,
    );
  }
}

/**
 * Records a failed attempt and applies a lockout once the threshold is
 * crossed. Returns the lock duration applied (0 when still under threshold).
 */
export async function recordFailedAttempt(
  scope: BruteForceScope,
  identifier: string,
): Promise<number> {
  const { attempts, lock } = keysFor(scope, identifier);

  try {
    const count = await redis.incr(attempts);

    // Only set the TTL on the first failure, so the window is a fixed period
    // after the first attempt rather than sliding forward with each new one.
    if (count === 1) {
      await redis.expire(attempts, env.AUTH_BRUTE_FORCE_WINDOW_SECONDS);
    }

    const lockSeconds = lockSecondsFor(count);
    if (lockSeconds > 0) {
      await redis.set(lock, "1", "EX", lockSeconds);
      logger.warn({ scope, attempts: count, lockSeconds }, "Brute-force lockout applied");
    }

    return lockSeconds;
  } catch (error) {
    logger.warn({ err: error, scope }, "Brute-force counter skipped — Redis unavailable");
    return 0;
  }
}

/** Clears the counter after a genuine success. */
export async function clearFailedAttempts(
  scope: BruteForceScope,
  identifier: string,
): Promise<void> {
  const { attempts, lock } = keysFor(scope, identifier);

  try {
    await redis.del(attempts, lock);
  } catch (error) {
    logger.warn({ err: error, scope }, "Brute-force reset skipped — Redis unavailable");
  }
}
