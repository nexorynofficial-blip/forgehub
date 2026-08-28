import { Router } from "express";

import { env } from "../../config/env.js";
import { optionalAuth } from "../../middleware/auth.middleware.js";
import { createRateLimiter } from "../../middleware/rate-limit.middleware.js";
import { validate } from "../../middleware/validation.middleware.js";
import * as controller from "./search.controller.js";
import { searchQuerySchema } from "./search.schema.js";

/**
 * Search endpoints (BACKEND_ARCHITECTURE.md §24, §28, §29).
 *
 * Routes wire middleware to a controller and contain no logic of their own.
 *
 * **One route** (ruling D5). §29 names `/api/v1/search` and nothing else; the
 * entity filter is a query parameter rather than a path segment, so there is
 * one contract, one rate limiter, and one place where authentication is
 * decided. `/search/users`, `/search/projects`, and friends are deliberately
 * absent.
 *
 * `optionalAuth`, not `requireAuth` (ruling D4). The same choice communities,
 * posts, projects, and profiles make for their reads: public content must be
 * findable by an anonymous visitor, and the shipped topbar renders its search
 * input before anyone signs in. A signed-in viewer is not given *access* by
 * authenticating — they are given *evaluation*, so their own private projects,
 * their memberships, their follows, and the blocks against them are all
 * resolved. Anonymous callers see strictly public rows and nothing else.
 *
 * A factory rather than a module-level router, for the reason every router
 * since Phase 3 is one: the limiter below builds a Redis-backed store on
 * construction, and that must happen after `connectRedis()` — the shared
 * client runs with `enableOfflineQueue: false`, so building it earlier throws
 * at startup.
 */

/**
 * The stricter budget ARCHITECTURE §28 asks for.
 *
 * §28 lists Search alongside login, registration, and messaging under
 * "Stricter limits", and separately under "Public APIs vulnerable to abuse".
 * Both readings point the same way: this endpoint runs five `ILIKE` scans per
 * request against an unindexed match (ruling D2), so it is the most expensive
 * anonymous read in the API and needs a tighter budget than the general `/api`
 * limiter.
 *
 * "Stricter" is expressed **relative to the configured baseline** rather than
 * as an absolute number, which is what §28's stricter/more-generous framing
 * actually means. Three things follow, all of them wanted:
 *
 *   - A deployment that tunes `RATE_LIMIT_MAX` moves both limits together,
 *     instead of leaving search pinned to a constant that silently becomes
 *     more or less strict than intended.
 *   - No new environment variable is required, so `config/env.ts` and
 *     `.env.example` stay untouched by this phase.
 *   - The test bootstrap already raises `RATE_LIMIT_MAX` so suites do not trip
 *     limiters mid-run, and this inherits that automatically. A hardcoded
 *     number would have made the integration suite untestable without editing
 *     shared test setup.
 *
 * At the shipped baseline of 100/minute this yields 30/minute: one search
 * every two seconds, which no human typing in a box will notice, and roughly
 * a third of a scraper's throughput. The floor keeps a very small configured
 * baseline from producing a limit of zero.
 */
const SEARCH_RATE_LIMIT_SHARE = 0.3;
const SEARCH_RATE_LIMIT_FLOOR = 5;

function searchRateLimitMax(): number {
  return Math.max(
    SEARCH_RATE_LIMIT_FLOOR,
    Math.ceil(env.RATE_LIMIT_MAX * SEARCH_RATE_LIMIT_SHARE),
  );
}

export function createSearchRouter(): Router {
  const router = Router();

  /*
   * KNOWN PRE-EXISTING DEFECT, deliberately not fixed here (ruling D13).
   *
   * `rate-limit.middleware.ts` gives every limiter the same Redis key prefix,
   * `rl:`, and `express-rate-limit` keys on the client IP. The `name` below
   * reaches the log line and nothing else, so this limiter *shares a counter*
   * with the global `/api` limiter and with `auth-credentials` for the same
   * IP — the tighter budget wins for every one of them, and requests to
   * unrelated endpoints consume this one's allowance.
   *
   * The defect dates from Phase 2 and is out of scope for Phase 10; fixing it
   * means editing a previous-phase middleware that this phase may not touch.
   * It is recorded here, and in `docs/SEARCH.md`, so the limiter's real
   * behaviour is not mistaken for its declared behaviour.
   */
  const searchLimiter = createRateLimiter({
    name: "search",
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: searchRateLimitMax(),
  });

  router.get(
    "/",
    searchLimiter,
    optionalAuth,
    validate({ query: searchQuerySchema }),
    controller.search,
  );

  return router;
}
