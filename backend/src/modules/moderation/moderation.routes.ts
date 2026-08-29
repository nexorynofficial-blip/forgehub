import { Router } from "express";

import { env } from "../../config/env.js";
import { requireAuth } from "../../middleware/auth.middleware.js";
import { createRateLimiter } from "../../middleware/rate-limit.middleware.js";
import { requireAdmin } from "../../middleware/role.middleware.js";
import { validate } from "../../middleware/validation.middleware.js";
import * as controller from "./moderation.controller.js";
import {
  createActionSchema,
  createReportSchema,
  listReportsQuerySchema,
  reportIdParamSchema,
  updateReportSchema,
} from "./moderation.schema.js";

/**
 * Moderation endpoints, mounted at `/api/v1/moderation`
 * (ARCHITECTURE §25, §29).
 *
 * §29 names `/api/v1/moderation` and `/api/v1/admin` as two separate roots,
 * and they stay separate here: this router is the moderation *workflow* —
 * reports and the actions taken on them — while `/admin` is platform
 * administration. Splitting them means the two can be gated differently, and
 * they are: everything below is `requireAdmin`, while role changes and audit
 * reads under `/admin` are `requirePlatformAdmin`.
 *
 * ## Two authorization tiers
 *
 * `POST /reports` is `requireAuth` only. PRD §17 opens with *"Users must be
 * able to report"* and PRD §3 lists "Report users" among ordinary user
 * capabilities — reporting is something every signed-in person does, not a
 * staff action. Every other route is `requireAdmin`, because reviewing the
 * queue means reading who reported whom, and acting on it means changing
 * another person's standing.
 *
 * Anonymous callers are rejected everywhere. There is no `optionalAuth` in
 * this module: an unattributed report is not actionable, and an anonymous
 * report queue would be a directory of everyone under review.
 *
 * A factory rather than a module-level router, for the reason every router
 * since Phase 3 is one: the limiter below builds a Redis-backed store on
 * construction, and that must happen after `connectRedis()`.
 */

/**
 * The stricter budget report filing needs (ruling R14).
 *
 * ARCHITECTURE §28 does not name reporting in its "Stricter limits" list, but
 * it does name *"Public APIs vulnerable to abuse"*, and a report endpoint is
 * one: each call writes two rows and a mass-filing campaign is a way to bury a
 * moderation queue in noise, which is a denial of service against the
 * moderators rather than against the server.
 *
 * Expressed **relative to the configured baseline**, exactly as Phase 10's
 * search limiter is, and for the same three reasons: a deployment that tunes
 * `RATE_LIMIT_MAX` moves this with it, no new environment variable is needed
 * so `config/env.ts` and `.env.example` stay untouched, and the test bootstrap
 * that raises `RATE_LIMIT_MAX` is inherited automatically.
 *
 * The share is a tenth rather than search's three tenths because the two
 * endpoints are abused differently. Search is expensive per call and a human
 * makes many of them; reporting is cheap per call and a human makes very few.
 * At the shipped baseline of 100/minute this yields 10 reports a minute, which
 * no genuine user will reach and which makes bulk filing tedious. The floor of
 * 3 keeps a very small configured baseline from producing a limit of zero.
 *
 * KNOWN PRE-EXISTING DEFECT, deliberately not fixed here (ruling R14).
 * `rate-limit.middleware.ts` gives every limiter the same Redis key prefix,
 * `rl:`, and `express-rate-limit` keys on the client IP. The `name` below
 * reaches the log line and nothing else, so this limiter *shares a counter*
 * with the global `/api` limiter, with `auth-credentials`, and with Phase 10's
 * `search` limiter for the same IP — the tightest budget wins for all of them,
 * and requests to unrelated endpoints consume this one's allowance. The defect
 * dates from Phase 2 and fixing it means editing a previous-phase middleware
 * this phase may not touch. It is recorded here and in `docs/MODERATION.md` so
 * the limiter's real behaviour is not mistaken for its declared behaviour.
 */
const REPORT_RATE_LIMIT_SHARE = 0.1;
const REPORT_RATE_LIMIT_FLOOR = 3;

function reportRateLimitMax(): number {
  return Math.max(
    REPORT_RATE_LIMIT_FLOOR,
    Math.ceil(env.RATE_LIMIT_MAX * REPORT_RATE_LIMIT_SHARE),
  );
}

export function createModerationRouter(): Router {
  const router = Router();

  const reportLimiter = createRateLimiter({
    name: "moderation-report",
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: reportRateLimitMax(),
  });

  // Filing a report: any authenticated user, rate limited.
  router.post(
    "/reports",
    reportLimiter,
    requireAuth,
    validate({ body: createReportSchema }),
    controller.createReport,
  );

  // The queue and everything that acts on it: staff only.
  router.get(
    "/reports",
    requireAuth,
    requireAdmin,
    validate({ query: listReportsQuerySchema }),
    controller.listReports,
  );

  router.get(
    "/reports/:id",
    requireAuth,
    requireAdmin,
    validate({ params: reportIdParamSchema }),
    controller.getReport,
  );

  router.patch(
    "/reports/:id",
    requireAuth,
    requireAdmin,
    validate({ params: reportIdParamSchema, body: updateReportSchema }),
    controller.updateReport,
  );

  router.post(
    "/actions",
    requireAuth,
    requireAdmin,
    validate({ body: createActionSchema }),
    controller.createAction,
  );

  return router;
}
