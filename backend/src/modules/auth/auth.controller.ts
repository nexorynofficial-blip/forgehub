import type { Request, RequestHandler, Response } from "express";

import {
  clearRefreshCookie,
  clearTwoFactorChallengeCookie,
  cookieNames,
  setRefreshCookie,
  setTwoFactorChallengeCookie,
} from "../../config/cookies.js";
import { auditContextFromRequest } from "../../utils/audit.js";
import { AppError } from "../../utils/errors.js";
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
