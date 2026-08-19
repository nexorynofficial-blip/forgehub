import type { RequestHandler, Response } from "express";
import { pinoHttp } from "pino-http";

import { logger } from "../utils/logger.js";

/**
 * HTTP access logging. Health probes are silenced — Kubernetes/Docker poll
 * them every few seconds and would otherwise drown out real traffic.
 */
export const requestLogger: RequestHandler = pinoHttp({
  logger,
  // pino-http types `res` as the raw ServerResponse; under Express it is
  // always the augmented Response carrying `locals` (set by `requestId`).
  genReqId: (_req, res) =>
    ((res as Response).locals["requestId"] as string | undefined) ?? "unknown",
  autoLogging: {
    ignore: (req) => req.url === "/health" || req.url === "/ready",
  },
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  // The default serializers log full header sets; trim to what aids debugging.
  serializers: {
    req: (req) => ({ method: req.method, url: req.url }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
}) as unknown as RequestHandler;
