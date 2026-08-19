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

function createStore(): Options["store"] | undefined {
  // Tests run without Redis; the memory store keeps them hermetic.
  if (isTest) return undefined;

  return new RedisStore({
    // ioredis types `call` as (command, ...args); rate-limit-redis hands us a
    // flat string[], so the command is split off the front explicitly.
    sendCommand: (command: string, ...args: string[]) =>
      redis.call(command, ...args) as Promise<never>,
    prefix: "rl:",
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
  const store = createStore();

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
