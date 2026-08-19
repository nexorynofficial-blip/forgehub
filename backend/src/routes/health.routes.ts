import { Router } from "express";

import { checkDatabaseConnection } from "../database/prisma.js";
import { ErrorCode } from "../utils/errors.js";
import { checkRedisConnection } from "../config/redis.js";
import { errorResponse, successResponse } from "../utils/response.js";

/**
 * Liveness and readiness probes, mounted at the root (not under `/api/v1`) —
 * orchestrators probe the process, and those probes should not move when the
 * API version changes.
 */
export const healthRouter: Router = Router();

const startedAt = Date.now();

/**
 * Liveness: is the process up and able to serve? Deliberately checks no
 * dependencies — a failing DB should not cause the orchestrator to kill and
 * restart an otherwise healthy container (that is what readiness is for).
 */
healthRouter.get("/health", (_req, res) => {
  res.json(
    successResponse(
      {
        status: "ok",
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        timestamp: new Date().toISOString(),
      },
      "Service is healthy",
    ),
  );
});

/**
 * Readiness: can this instance serve real traffic? Verifies every critical
 * dependency and returns 503 if any is down, so a load balancer stops
 * routing to it until it recovers.
 */
healthRouter.get("/ready", async (_req, res) => {
  const [database, cache] = await Promise.all([
    checkDatabaseConnection(),
    checkRedisConnection(),
  ]);

  const dependencies = {
    database: database ? ("up" as const) : ("down" as const),
    redis: cache ? ("up" as const) : ("down" as const),
  };

  if (!database || !cache) {
    res
      .status(503)
      .json(
        errorResponse(
          ErrorCode.SERVICE_UNAVAILABLE,
          "One or more dependencies are unavailable",
        ),
      );
    return;
  }

  res.json(
    successResponse({ status: "ready", dependencies }, "All dependencies are healthy"),
  );
});
