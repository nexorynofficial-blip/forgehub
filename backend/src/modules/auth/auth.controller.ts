import type { Request, RequestHandler, Response } from "express";

import {
  clearOAuthStateCookie,
  clearRefreshCookie,
  clearTwoFactorChallengeCookie,
  cookieNames,
  setOAuthStateCookie,
  setRefreshCookie,
  setTwoFactorChallengeCookie,
} from "../../config/cookies.js";
import { env } from "../../config/env.js";
import { isGoogleOAuthConfigured } from "../../integrations/oauth/google.js";
import { safeInternalPath } from "../../utils/redirect.js";
import { auditContextFromRequest } from "../../utils/audit.js";
import { AppError } from "../../utils/errors.js";
import { OAUTH_COMPLETION_PATH, TWO_FACTOR_PATH } from "./auth.frontend-routes.js";
import { successResponse } from "../../utils/response.js";
import { validated } from "../../middleware/validation.middleware.js";
import * as authService from "./auth.service.js";
import type {
  ChangePasswordInput,
  ForgotPasswordInput,
  LoginInput,
  RegisterInput,
  ResendVerificationInput,
  ResetPasswordInput,
  SessionIdParam,
  TwoFactorChallengeInput,
  TwoFactorConfirmInput,
  TwoFactorDisableInput,
  VerifyEmailInput,
} from "./auth.schema.js";
import type { AuthenticatedResult, LoginResult } from "./auth.types.js";

/**
 * HTTP adapter for the auth module (BACKEND_ARCHITECTURE.md §4–5).
 *
 * Controllers translate between HTTP and the service, and nothing else: no
 * business rules, no Prisma. The one thing they *do* own is cookie handling —
 * the service returns a refresh token, and moving it into an httpOnly cookie
 * (rather than a JSON field) is a transport concern that belongs here.
 *
 * Express 5 forwards rejected promises from async handlers to the error
 * middleware automatically, so no try/catch wrapper is needed.
 */

/** Identity is always read from `req.user`, never from the request payload. */
function requireUser(req: Request): NonNullable<Request["user"]> {
  if (!req.user) {
    // Unreachable behind `requireAuth`; asserted so the types stay honest.
    throw AppError.authentication("Authentication required");
  }
  return req.user;
}

function readCookie(req: Request, name: string): string | null {
  const cookies = req.cookies as Record<string, string> | undefined;
  const value = cookies?.[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Writes the refresh token to its cookie and returns the JSON-safe half.
 *
 * This is the single chokepoint enforcing J1: the refresh token is stripped
 * here and can never reach a response body.
 */
function respondAuthenticated(
  res: Response,
  result: AuthenticatedResult,
  message: string,
  status = 200,
): void {
  setRefreshCookie(res, result.tokens.refreshToken, result.tokens.refreshMaxAgeMs);
  clearTwoFactorChallengeCookie(res);

  res.status(status).json(
    successResponse(
      {
        user: result.user,
        accessToken: result.tokens.accessToken,
        // Lets a client schedule a refresh without decoding the JWT.
        expiresIn: result.tokens.refreshMaxAgeMs,
      },
      message,
    ),
  );
}

/** Login and the 2FA challenge share this branch on the service's result. */
function respondLoginResult(res: Response, result: LoginResult, message: string): void {
  if (result.status === "two_factor_required") {
    setTwoFactorChallengeCookie(res, result.challengeToken);
    res.json(
      successResponse(
        { twoFactorRequired: true, challengeToken: result.challengeToken },
        "Two-factor verification required",
      ),
    );
    return;
  }

  respondAuthenticated(res, result, message);
}

/* ── Registration & login ───────────────────────────────────────────────── */

export const register: RequestHandler = async (req, res) => {
  const result = await authService.register(
    req.body as RegisterInput,
    auditContextFromRequest(req),
  );

  res
    .status(201)
    .json(successResponse(result, "Account created — check your email to verify it"));
};

export const login: RequestHandler = async (req, res) => {
  const result = await authService.login(
    req.body as LoginInput,
    auditContextFromRequest(req),
  );

  respondLoginResult(res, result, "Signed in successfully");
};

export const refresh: RequestHandler = async (req, res) => {
  const token = readCookie(req, cookieNames.refresh);

  if (!token) {
    throw AppError.authentication("No refresh token provided");
  }

  const result = await authService.refresh(token, auditContextFromRequest(req));

  respondAuthenticated(
    res,
    { status: "authenticated", user: result.user, tokens: result.tokens },
    "Session refreshed",
  );
};

export const logout: RequestHandler = async (req, res) => {
  await authService.logout(
    readCookie(req, cookieNames.refresh),
    auditContextFromRequest(req),
    req.user?.sessionId,
  );

  clearRefreshCookie(res);
  clearTwoFactorChallengeCookie(res);

  res.json(successResponse({ signedOut: true }, "Signed out successfully"));
};

export const me: RequestHandler = async (req, res) => {
  const user = await authService.getCurrentUser(requireUser(req).id);
  res.json(successResponse({ user }, "Current user retrieved"));
};

/* ── Email verification ─────────────────────────────────────────────────── */

export const verifyEmail: RequestHandler = async (req, res) => {
  const { token } = req.body as VerifyEmailInput;
  const user = await authService.verifyEmail(token, auditContextFromRequest(req));

  res.json(successResponse({ user }, "Email address verified"));
};

export const resendVerification: RequestHandler = async (req, res) => {
  const { email } = req.body as ResendVerificationInput;
  await authService.resendVerification(email, auditContextFromRequest(req));

  // Deliberately identical whether or not the address exists.
  res.json(
    successResponse(
      { sent: true },
      "If that address needs verifying, a new link is on its way",
    ),
  );
};

/* ── Password ───────────────────────────────────────────────────────────── */

export const forgotPassword: RequestHandler = async (req, res) => {
  const { email } = req.body as ForgotPasswordInput;
  await authService.forgotPassword(email, auditContextFromRequest(req));

  res.json(
    successResponse(
      { sent: true },
      "If an account exists for that address, a reset link is on its way",
    ),
  );
};

export const resetPassword: RequestHandler = async (req, res) => {
  const { token, password } = req.body as ResetPasswordInput;
  await authService.resetPassword(token, password, auditContextFromRequest(req));

  // Every session died with the reset, including any this browser held.
  clearRefreshCookie(res);

  res.json(successResponse({ reset: true }, "Password updated — please sign in again"));
};

export const changePassword: RequestHandler = async (req, res) => {
  const user = requireUser(req);

  await authService.changePassword(
    user.id,
    user.sessionId,
    req.body as ChangePasswordInput,
    auditContextFromRequest(req),
  );

  res.json(
    successResponse(
      { changed: true },
      "Password changed — other devices have been signed out",
    ),
  );
};

/* ── Sessions ───────────────────────────────────────────────────────────── */

export const listSessions: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const sessions = await authService.listSessions(user.id, user.sessionId);

  res.json(successResponse({ sessions }, "Active sessions retrieved"));
};

export const revokeSession: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { id } = validated<SessionIdParam>(res, "Params");

  await authService.revokeSession(user.id, id, auditContextFromRequest(req));

  res.json(successResponse({ revoked: true }, "Session revoked"));
};

export const revokeOtherSessions: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const revoked = await authService.revokeOtherSessions(
    user.id,
    user.sessionId,
    auditContextFromRequest(req),
  );

  res.json(successResponse({ revoked }, "Other sessions revoked"));
};

/* ── Two-factor authentication ──────────────────────────────────────────── */

export const startTwoFactor: RequestHandler = async (req, res) => {
  const enrollment = await authService.startTwoFactorEnrollment(
    requireUser(req).id,
    auditContextFromRequest(req),
  );

  res.json(
    successResponse(
      enrollment,
      "Scan the QR code, then confirm with a code to finish setup",
    ),
  );
};

export const confirmTwoFactor: RequestHandler = async (req, res) => {
  const { code } = req.body as TwoFactorConfirmInput;
  const result = await authService.confirmTwoFactor(
    requireUser(req).id,
    code,
    auditContextFromRequest(req),
  );

  res.json(
    successResponse(
      result,
      "Two-factor authentication enabled — store your backup codes now",
    ),
  );
};

export const disableTwoFactor: RequestHandler = async (req, res) => {
  const { password } = req.body as TwoFactorDisableInput;
  await authService.disableTwoFactor(
    requireUser(req).id,
    password,
    auditContextFromRequest(req),
  );

  res.json(successResponse({ enabled: false }, "Two-factor authentication disabled"));
};

/**
 * Completes a 2FA login. The challenge token comes from the cookie set at
 * login, falling back to the request body so non-browser clients (and the
 * shipped `/2fa` page, which holds no state) both work.
 */
export const challengeTwoFactor: RequestHandler = async (req, res) => {
  const body = req.body as TwoFactorChallengeInput;
  const challengeToken = body.challengeToken ?? readCookie(req, cookieNames.twoFactor);

  if (!challengeToken) {
    throw AppError.authentication("This verification session has expired");
  }

  const result = await authService.completeTwoFactorChallenge(
    { challengeToken, code: body.code, backupCode: body.backupCode },
    auditContextFromRequest(req),
  );

  respondLoginResult(res, result, "Signed in successfully");
};

/* ── Google sign-in ─────────────────────────────────────────────────────── */

/**
 * The provider routes answer with **redirects**, not JSON, because the client
 * is a browser mid-navigation rather than the API client. Everything the
 * frontend needs afterwards it gets the ordinary way: the refresh cookie is
 * already set, so the completion page calls `/auth/refresh` like any reload.
 *
 * Consequently no token of any kind is ever placed in a redirect URL. The
 * only thing that crosses in the query string is an error code from the
 * closed set in `auth.service.ts`.
 */

/**
 * A query parameter, but only when it is a single plain string.
 *
 * Express parses `?state=a&state=b` into an array. For a value whose whole
 * job is to be compared against a cookie, "which one did you mean" is not a
 * question worth answering — a duplicated parameter is an attack shape, and
 * this returns `null` for it.
 */
function readQuery(req: Request, name: string): string | null {
  const value = (req.query as Record<string, unknown>)[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Absolute URL on the configured frontend origin. */
function frontendUrl(path: string, params?: Record<string, string>): string {
  const url = new URL(path, env.APP_URL);
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/** Where every OAuth outcome lands. The page reads `error` or refreshes. */
function completionUrl(params?: Record<string, string>): string {
  return frontendUrl(OAUTH_COMPLETION_PATH, params);
}

export const startGoogleOAuth: RequestHandler = async (req, res) => {
  if (!isGoogleOAuthConfigured()) {
    // Not a 503: the caller is a browser that just left the sign-in page, and
    // a JSON error body would render as raw text. It is told the same way
    // every other failure is told.
    res.redirect(completionUrl({ error: authService.OAuthError.UNAVAILABLE }));
    return;
  }

  const start = await authService.startGoogleOAuth(
    safeInternalPath(readQuery(req, "next")),
  );

  setOAuthStateCookie(res, start.state, start.maxAgeMs);
  res.redirect(start.redirectUrl);
};

export const googleOAuthCallback: RequestHandler = async (req, res) => {
  // Unconditional, and before anything can return: the state is single-use,
  // so it must not survive the request that spent it — including the requests
  // that failed, where leaving it would invite a retry against a stale value.
  clearOAuthStateCookie(res);

  const result = await authService.completeGoogleOAuth(
    {
      code: readQuery(req, "code"),
      state: readQuery(req, "state"),
      cookieState: readCookie(req, cookieNames.oauthState),
      providerError: readQuery(req, "error"),
    },
    auditContextFromRequest(req),
  );

  if (result.status === "failed") {
    res.redirect(completionUrl({ error: result.code }));
    return;
  }

  if (result.login.status === "two_factor_required") {
    // The same challenge cookie the password flow sets, read by the same
    // `/2fa` page, completed by the same endpoint.
    setTwoFactorChallengeCookie(res, result.login.challengeToken);
    res.redirect(frontendUrl(TWO_FACTOR_PATH));
    return;
  }

  setRefreshCookie(
    res,
    result.login.tokens.refreshToken,
    result.login.tokens.refreshMaxAgeMs,
  );
  clearTwoFactorChallengeCookie(res);

  // `next` was validated as an internal path before it was stored, and is
  // re-validated by the page that receives it. The access token is not here,
  // and cannot be: the completion page asks `/auth/refresh` for one.
  res.redirect(completionUrl(result.next !== null ? { next: result.next } : undefined));
};
