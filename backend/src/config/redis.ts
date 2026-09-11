import { Redis, type RedisOptions } from "ioredis";

import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

/**
 * Shared Redis client. Later phases layer caching, presence, BullMQ queues,
 * and the Socket.IO adapter on top of this one connection factory rather
 * than each opening their own.
 */

const options: RedisOptions = {
  // Fail fast instead of queueing commands forever when Redis is down; the
  // readiness probe should report unhealthy, not hang.
  maxRetriesPerRequest: 3,
  enableOfflineQueue: false,
  retryStrategy: (times) => Math.min(times * 200, 5_000),
  lazyConnect: true,
};

export const redis = new Redis(env.REDIS_URL, options);

redis.on("error", (error: Error) => {
  logger.error({ err: error }, "Redis client error");
});

redis.on("connect", () => {
  logger.info("Redis connected");
});

redis.on("reconnecting", () => {
  logger.warn("Redis reconnecting");
});

/**
 * Some consumers (the Socket.IO pub/sub adapter, BullMQ) require their own
 * dedicated connections — a client in subscriber mode cannot issue normal
 * commands. This factory keeps those consistent with the shared config.
 */
export function createRedisClient(overrides: Partial<RedisOptions> = {}): Redis {
  const client = new Redis(env.REDIS_URL, { ...options, ...overrides });
  // Every client needs its own listener. An EventEmitter with no `error`
  // handler throws the event instead, so a single dropped connection would
  // crash the process rather than trigger ioredis's own reconnect.
  client.on("error", (error: Error) => {
    logger.error({ err: error }, "Redis client error (dedicated connection)");
  });
  return client;
}

export async function connectRedis(): Promise<void> {
  // `lazyConnect` means the connection is only established on demand.
  if (redis.status === "wait") {
    await redis.connect();
  }
}

/** Verifies the connection is live. Used by `/ready` and at startup. */
export async function checkRedisConnection(): Promise<boolean> {
  try {
    const result = await redis.ping();
    return result === "PONG";
  } catch (error) {
    logger.error({ err: error }, "Redis health check failed");
    return false;
  }
}

export async function disconnectRedis(): Promise<void> {
  await redis.quit();
  logger.info("Redis disconnected");
}
