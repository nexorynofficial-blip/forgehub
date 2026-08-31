import type { RequestHandler } from "express";
import rateLimit, { type Options } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";

import { env, isTest } from "../config/env.js";
import { ErrorCode } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { redis } from "../config/redis.js";
import { errorResponse } from "../utils/response.js";

/**
 * Rate limiting foundation (TRD.md §7).
 *
 * Counters live in Redis rather than process memory so the limit holds across
 * multiple backend instances and survives restarts — in-memory counters would
 * let an attacker reset their budget by hitting a different replica.
 */

/**
 * Redis key prefix for one limiter.
 *
 * Every limiter used to share the literal prefix `rl:`, and `express-rate-limit`
 * keys on the client IP, so all four limiters incremented **one** counter —
 * `rl:<ip>`. Two consequences followed, both measured against a live Redis:
 *
 *  1. *Shared budget.* A request passing through the global limiter and a route
 *     limiter counted **twice**, and traffic to unrelated endpoints spent the
 *     credential limiter's allowance. Three searches left the shared key at 6.
 *  2. *Collapsed window.* `rate-limit-redis` sets the TTL when it creates the
 *     key, so whichever limiter arrived first fixed the window for all of them.
 *     A login observed a TTL of 58s — the global limiter's 60s window — not the
 *     900s `AUTH_RATE_LIMIT_WINDOW_MS` configures. That is the security-relevant
 *     half: it multiplies the credential-guessing rate the design allows.
 *
 * BACKEND_ARCHITECTURE.md §28 requires *stricter* limits on login, registration
 * and search and *more generous* limits on ordinary authenticated requests. One
 * shared counter cannot express both at once — the tightest budget and the
 * shortest window win for everything — so the shared prefix did not merely blur
 * the limiters, it made the specified policy unimplementable.
 *
 * Namespacing by `name` gives each limiter its own counter and its own TTL.
 * `tests/auth-rate-limit.test.ts` already assumed exactly this: it raises
 * `RATE_LIMIT_MAX` to 100000 to push the global limiter "out of the way" so only
 * the credential limiter can answer 429. That isolation was real under the
 * in-memory test store and absent in production; this closes the gap.
 */
export function rateLimiterKeyPrefix(name: string): string {
  return `rl:${name}:`;
}

function createStore(name: string): Options["store"] | undefined {
  // Tests run without Redis; the memory store keeps them hermetic.
  if (isTest) return undefined;

  return new RedisStore({
    // ioredis types `call` as (command, ...args); rate-limit-redis hands us a
    // flat string[], so the command is split off the front explicitly.
    sendCommand: (command: string, ...args: string[]) =>
      redis.call(command, ...args) as Promise<never>,
    prefix: rateLimiterKeyPrefix(name),
  });
}

interface LimiterConfig {
  windowMs?: number;
  max?: number;
  name: string;
}

/**
 * Must be called *after* `connectRedis()` — `RedisStore`'s constructor
 * immediately issues a command to load its Lua script, and the shared client
 * runs with `enableOfflineQueue: false`, so building a limiter against an
 * unconnected client throws at startup.
 */
export function createRateLimiter({
  windowMs,
  max,
  name,
}: LimiterConfig): RequestHandler {
  const store = createStore(name);

  return rateLimit({
    windowMs: windowMs ?? env.RATE_LIMIT_WINDOW_MS,
    limit: max ?? env.RATE_LIMIT_MAX,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    // Fail open if Redis becomes unreachable mid-flight: a rate limiter going
    // down should degrade enforcement, not take the whole API offline.
    passOnStoreError: true,
    ...(store ? { store } : {}),
    handler: (req, res) => {
      logger.warn(
        { limiter: name, ip: req.ip, path: req.originalUrl },
        "Rate limit exceeded",
      );
      res
        .status(429)
        .json(
          errorResponse(
            ErrorCode.RATE_LIMITED,
            "Too many requests — please try again shortly",
          ),
        );
    },
  });
}

/** Baseline limit for the whole `/api` surface. Built per `createApp()` call. */
export function createGlobalRateLimiter(): RequestHandler {
  return createRateLimiter({ name: "global" });
}
