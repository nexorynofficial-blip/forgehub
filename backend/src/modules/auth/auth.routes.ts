import { Router } from "express";

import { env } from "../../config/env.js";
import { optionalAuth, requireAuth } from "../../middleware/auth.middleware.js";
import { createRateLimiter } from "../../middleware/rate-limit.middleware.js";
import { validate } from "../../middleware/validation.middleware.js";
import * as controller from "./auth.controller.js";
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  sessionIdParamSchema,
  twoFactorChallengeSchema,
  twoFactorConfirmSchema,
  twoFactorDisableSchema,
  verifyEmailSchema,
} from "./auth.schema.js";

/**
 * Auth endpoints (BACKEND_ARCHITECTURE.md §29).
 *
 * Routes wire middleware to controllers and contain no logic of their own.
 *
 * Built by a factory rather than exported as a module-level router because
 * the rate limiters below construct a Redis-backed store on creation, and
 * that must happen after `connectRedis()` — the shared client runs with
 * `enableOfflineQueue: false`, so building one earlier throws at startup.
 */
export function createAuthRouter(): Router {
  const router = Router();

  /**
   * Tight budget for the credential surface (ARCHITECTURE §28). This limits a
   * *source*; per-account lockout is a separate mechanism living in
   * `utils/brute-force.ts`. Both are needed: this one stops a single host
   * hammering the endpoint, that one stops a botnet spreading guesses for one
   * account across many hosts.
   */
  const credentialLimiter = createRateLimiter({
    name: "auth-credentials",
    windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
    max: env.AUTH_RATE_LIMIT_MAX,
  });

  /* ── Public credential endpoints ──────────────────────────────────────── */

  router.post(
    "/register",
    credentialLimiter,
    validate({ body: registerSchema }),
    controller.register,
  );

  router.post(
    "/login",
    credentialLimiter,
    validate({ body: loginSchema }),
    controller.login,
  );

  /** Authenticated by the refresh cookie itself, so no `requireAuth`. */
  router.post("/refresh", controller.refresh);

  /**
   * `optionalAuth`, not `requireAuth`. Signing out must work when the access
   * token has already expired — exactly when a user is most likely to click
   * it — so an invalid token cannot be a hard failure. But a *valid* one has
   * to be honoured, or a native client holding only a bearer token (no
   * cookie) would get a cheerful 200 and stay signed in.
   */
  router.post("/logout", optionalAuth, controller.logout);

  router.get("/me", requireAuth, controller.me);

  /* ── Google sign-in ───────────────────────────────────────────────────── */

  /**
   * Both are `GET` because both are browser navigations: the first sends the
   * user to Google, the second is Google sending them back. Neither carries a
   * body, and neither can be a `fetch` — the user has to *see* the consent
   * screen.
   *
   * The credential limiter guards the start route only. Applying it to the
   * callback would answer a legitimate user mid-sign-in with a JSON 429 in
   * place of a page, and the callback already has a stronger guard than a
   * rate limit: a single-use state that must match a cookie this server set,
   * which no attacker can forge and no replay can spend twice.
   */
  router.get("/google", credentialLimiter, controller.startGoogleOAuth);
  router.get("/google/callback", controller.googleOAuthCallback);

  /* ── Email verification ───────────────────────────────────────────────── */

  router.post(
    "/verify-email",
    credentialLimiter,
    validate({ body: verifyEmailSchema }),
    controller.verifyEmail,
  );

  router.post(
    "/verify-email/resend",
    credentialLimiter,
    validate({ body: resendVerificationSchema }),
    controller.resendVerification,
  );

  /* ── Password ─────────────────────────────────────────────────────────── */

  router.post(
    "/password/forgot",
    credentialLimiter,
    validate({ body: forgotPasswordSchema }),
    controller.forgotPassword,
  );

  router.post(
    "/password/reset",
    credentialLimiter,
    validate({ body: resetPasswordSchema }),
    controller.resetPassword,
  );

  router.post(
    "/password/change",
    requireAuth,
    validate({ body: changePasswordSchema }),
    controller.changePassword,
  );

  /* ── Sessions ─────────────────────────────────────────────────────────── */

  router.get("/sessions", requireAuth, controller.listSessions);
  router.delete("/sessions", requireAuth, controller.revokeOtherSessions);
  router.delete(
    "/sessions/:id",
    requireAuth,
    validate({ params: sessionIdParamSchema }),
    controller.revokeSession,
  );

  /* ── Two-factor authentication ────────────────────────────────────────── */

  router.post("/2fa/setup", requireAuth, controller.startTwoFactor);

  router.post(
    "/2fa/confirm",
    requireAuth,
    validate({ body: twoFactorConfirmSchema }),
    controller.confirmTwoFactor,
  );

  router.post(
    "/2fa/disable",
    requireAuth,
    validate({ body: twoFactorDisableSchema }),
    controller.disableTwoFactor,
  );

  /** Public: the caller is mid-login and holds no access token yet. */
  router.post(
    "/2fa/challenge",
    credentialLimiter,
    validate({ body: twoFactorChallengeSchema }),
    controller.challengeTwoFactor,
  );

  return router;
}
