import { createRequire } from "node:module";
import pino, { type LoggerOptions } from "pino";

import { env, isDevelopment, isProduction } from "../config/env.js";

/**
 * Fields that must never reach the log sink (BACKEND_TRD.md §30). Pino
 * redacts these paths across every log record, so a careless
 * `logger.info({ req })` cannot leak a bearer token or password into log
 * storage.
 *
 * Exported so the test suite can assert the policy against a real logger
 * rather than restating the list and hoping the two stay in sync.
 */
const SENSITIVE_KEYS = [
  "password",
  "currentPassword",
  "newPassword",
  "confirmPassword",
  "passwordHash",
  "token",
  "tokenHash",
  "accessToken",
  "refreshToken",
  "challengeToken",
  "secret",
  "backupCode",
  "backupCodes",
];

export const REDACTED_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers['set-cookie']",
  // Both forms are required. Pino's `*` matches exactly one intermediate
  // level, so `*.password` covers `{ body: { password } }` but *not* a
  // top-level `logger.info({ password })` — which is the shape service code
  // is most likely to produce by accident.
  ...SENSITIVE_KEYS,
  ...SENSITIVE_KEYS.map((key) => `*.${key}`),
];

const options: LoggerOptions = {
  level: env.LOG_LEVEL,
  redact: { paths: REDACTED_PATHS, censor: "[REDACTED]" },
  base: { service: "forgehub-backend", env: env.NODE_ENV },
  // Structured ISO timestamps ship better to aggregators than epoch millis.
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
};

/**
 * `pino-pretty` is a devDependency, so it is absent from the production
 * image (built with `--omit=dev`). Resolving it before use means a container
 * running with NODE_ENV=development still boots — it just logs NDJSON —
 * instead of crashing on a missing transport target.
 */
function prettyTransportAvailable(): boolean {
  if (!isDevelopment) return false;
  try {
    createRequire(import.meta.url).resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
}

/** Human-readable output locally; raw NDJSON everywhere else for log shippers. */
export const logger = prettyTransportAvailable()
  ? pino({
      ...options,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss",
          ignore: "pid,hostname,service,env",
        },
      },
    })
  : pino(options);

export { isProduction };
