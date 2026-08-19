import compression from "compression";
import cookieParser from "cookie-parser";
import express, { type Express } from "express";
import swaggerUi from "swagger-ui-express";

import { env, isProduction } from "./config/env.js";
import { openApiDocument } from "./config/openapi.js";
import { createV1Router } from "./routes/index.js";
import { errorHandler, notFoundHandler } from "./middleware/error.middleware.js";
import { createGlobalRateLimiter } from "./middleware/rate-limit.middleware.js";
import { requestLogger } from "./middleware/request-logger.middleware.js";
import {
  corsMiddleware,
  hidePoweredBy,
  requestId,
  securityHeaders,
} from "./middleware/security.middleware.js";
import { healthRouter } from "./routes/health.routes.js";

/**
 * Builds the Express application.
 *
 * Exported as a factory (rather than a module-level singleton) so tests can
 * construct an isolated app per suite via Supertest without binding a port.
 */
export function createApp(): Express {
  const app = express();

  // Trust the first proxy hop so `req.ip` reflects the real client behind
  // NGINX/Railway — rate limiting keys on it, so getting this wrong would
  // bucket every user under the proxy's address.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  // Correlation id first: every later log line and error carries it.
  app.use(requestId);
  app.use(hidePoweredBy);
  app.use(securityHeaders);
  app.use(corsMiddleware);
  app.use(compression());
  app.use(requestLogger);

  // Body limits cap memory per request (TRD.md §7 input hardening).
  app.use(express.json({ limit: env.BODY_LIMIT }));
  app.use(express.urlencoded({ extended: true, limit: env.BODY_LIMIT }));

  // The refresh token and the 2FA challenge travel as httpOnly cookies, so
  // `req.cookies` has to be populated before any auth route runs. Unsigned:
  // both values are already unguessable random tokens verified server-side,
  // and a signature would add a second secret without adding a guarantee.
  app.use(cookieParser());

  // Probes mount before the rate limiter — orchestrators poll them
  // continuously and must never be throttled.
  app.use(healthRouter);

  // Built here rather than at module scope so the Redis-backed store is
  // constructed after `connectRedis()` has run (see createRateLimiter).
  // Interactive API docs (TRD §31). The raw document is always served so
  // tooling can consume it; the browser UI is disabled in production, where
  // it would expose the full API surface to anonymous visitors.
  app.get("/api/v1/openapi.json", (_req, res) => {
    res.json(openApiDocument);
  });
  if (!isProduction) {
    app.use("/api/v1/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));
  }

  app.use("/api", createGlobalRateLimiter());
  app.use("/api/v1", createV1Router());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
