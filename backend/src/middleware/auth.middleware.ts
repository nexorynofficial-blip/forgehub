import type { Request, RequestHandler } from "express";

import { findActiveSessionWithUser } from "../modules/auth/auth.repository.js";
import { AppError } from "../utils/errors.js";
import { verifyAccessToken } from "../utils/jwt.js";

/**
 * Authentication middleware (BACKEND_ARCHITECTURE.md §18).
 *
 * Answers "who is this user?" only. Permission questions belong to
 * `role.middleware.ts` and to service-level ownership checks — conflating the
 * two is what §18 explicitly warns against.
 *
 * Identity is derived from the verified JWT and then re-read from the
 * database. A client-supplied `userId` in a body, query, or header is never
 * consulted.
 */

const BEARER_PREFIX = "Bearer ";

/** Reads the token from `Authorization: Bearer <token>`, or null. */
function extractBearerToken(req: Request): string | null {
  const header = req.get("authorization");
  if (!header || !header.startsWith(BEARER_PREFIX)) return null;

  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Verifies the token, confirms the session behind it is still live, and
 * attaches the result to `req.user`.
 *
 * The session lookup is what makes revocation immediate: without it, a
 * logged-out access token would keep working until it expired.
 */
async function authenticate(req: Request): Promise<void> {
  const token = extractBearerToken(req);

  if (!token) {
    throw AppError.authentication("Authentication required");
  }

  const claims = await verifyAccessToken(token);
  const active = await findActiveSessionWithUser(claims.sid, claims.sub);

  if (!active) {
    // Covers revoked, expired, and soft-deleted-owner sessions alike. One
    // message for all three — which case applies is not the caller's business.
    throw AppError.authentication("Session is no longer valid");
  }

  // Moderation state is re-read here, not taken from the token, so a ban
  // issued after the token was minted still takes effect (TRD §17).
  if (active.user.status === "banned") {
    throw AppError.authorization("This account has been suspended");
  }

  req.user = {
    id: active.user.id,
    email: active.user.email,
    username: active.user.username,
    displayName: active.user.displayName,
    role: active.user.role,
    status: active.user.status,
    emailVerified: active.user.emailVerified,
    sessionId: active.session.id,
  };
}

/** Rejects the request unless a valid token and live session are present. */
export const requireAuth: RequestHandler = (req, res, next) => {
  authenticate(req)
    .then(() => {
      // Mirrored onto locals so the error middleware and request logger can
      // attribute failures without reaching into `req`.
      res.locals["userId"] = req.user?.id;
      next();
    })
    .catch(next);
};

/**
 * Populates `req.user` when a valid token is present, and silently continues
 * when it is not. For endpoints whose response differs for signed-in users
 * but which anonymous callers may still reach.
 */
export const optionalAuth: RequestHandler = (req, res, next) => {
  if (!extractBearerToken(req)) {
    next();
    return;
  }

  authenticate(req)
    .then(() => {
      res.locals["userId"] = req.user?.id;
      next();
    })
    .catch(() => {
      // A bad token on an optional route is treated as "anonymous", not as an
      // error — the caller gets the public response.
      next();
    });
};

/**
 * Gate for actions that require a confirmed email address. Not applied to any
 * Phase 3 route; provided so later phases have one definition to reuse rather
 * than re-deriving the check.
 */
export const requireVerifiedEmail: RequestHandler = (req, _res, next) => {
  if (!req.user) {
    next(AppError.authentication("Authentication required"));
    return;
  }

  if (!req.user.emailVerified) {
    next(AppError.authorization("Verify your email address to continue"));
    return;
  }

  next();
};
