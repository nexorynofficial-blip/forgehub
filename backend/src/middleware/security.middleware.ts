import cors, { type CorsOptions } from "cors";
import type { RequestHandler } from "express";
import helmet from "helmet";
import { randomUUID } from "node:crypto";

import { env, isProduction } from "../config/env.js";
import { AppError } from "../utils/errors.js";

/**
 * Security middleware foundation (TRD.md §7). Full authentication and RBAC
 * arrive in a later phase; this establishes the transport-level protections
 * that should apply to every request regardless of auth state.
 */

/**
 * Helmet with a CSP that assumes a JSON API: no inline scripts, no framing,
 * no plugins. `crossOriginResourcePolicy` is relaxed to `cross-origin`
 * because the frontend is served from a different origin than this API.
 */
export const securityHeaders: RequestHandler = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: "cross-origin" },
  referrerPolicy: { policy: "no-referrer" },
  // HSTS only matters over TLS, and forcing it locally breaks http://localhost.
  hsts: isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
});

const corsOptions: CorsOptions = {
  origin(origin, callback) {
    // Same-origin/non-browser callers (curl, server-to-server, health probes)
    // send no Origin header — allowing them is not a CORS bypass, since CORS
    // only constrains browsers.
    if (!origin) {
      callback(null, true);
      return;
    }

    if (env.CORS_ORIGIN.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(AppError.authorization(`Origin ${origin} is not allowed by CORS`));
  },
  // Required for the refresh-token cookie the auth phase will introduce.
  credentials: true,
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
  exposedHeaders: ["X-Request-Id"],
  maxAge: 86_400,
};

export const corsMiddleware: RequestHandler = cors(corsOptions);

/**
 * Assigns every request a correlation id (honoring an inbound `X-Request-Id`
 * from an upstream proxy) so a single request can be traced across log lines.
 */
export const requestId: RequestHandler = (req, res, next) => {
  const inbound = req.get("X-Request-Id");
  const id = inbound && inbound.length <= 128 ? inbound : randomUUID();
  res.locals["requestId"] = id;
  res.setHeader("X-Request-Id", id);
  next();
};

/** Removes the framework fingerprint from responses. */
export const hidePoweredBy: RequestHandler = (_req, res, next) => {
  res.removeHeader("X-Powered-By");
  next();
};
