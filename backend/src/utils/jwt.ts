import type { UserRole } from "@prisma/client";
import { SignJWT, errors as joseErrors, jwtVerify } from "jose";
import { randomUUID } from "node:crypto";

import { env } from "../config/env.js";
import { AppError } from "./errors.js";

/**
 * Access-token signing and verification (BACKEND_TRD.md §12–13).
 *
 * Only *access* tokens are JWTs. Refresh tokens are opaque random strings
 * stored as keyed hashes (see `tokens.ts`) — a self-contained refresh JWT
 * could not be revoked before its expiry, which §13 requires.
 */

const ISSUER = "forgehub";
const AUDIENCE = "forgehub-api";
const ALGORITHM = "HS256";

const accessSecret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);

export interface AccessTokenClaims {
  /** User id. */
  sub: string;
  /** Session id — ties the access token to a revocable device session. */
  sid: string;
  role: UserRole;
  /** Unique token id, for audit correlation. */
  jti: string;
}

export interface AccessTokenInput {
  userId: string;
  sessionId: string;
  role: UserRole;
}

/**
 * Signs a short-lived access token. Lifetime comes from
 * `JWT_ACCESS_EXPIRES` (default 15m) — short enough that a leaked token
 * expires before it is worth much, since it cannot be revoked individually.
 */
export async function signAccessToken({
  userId,
  sessionId,
  role,
}: AccessTokenInput): Promise<string> {
  return new SignJWT({ sid: sessionId, role })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setJti(randomUUID())
    .setExpirationTime(env.JWT_ACCESS_EXPIRES)
    .sign(accessSecret);
}

/**
 * Verifies signature, algorithm, issuer, audience, and expiry.
 *
 * `algorithms` is pinned so a token whose header claims `alg: "none"` (or
 * any other algorithm) is rejected outright rather than being trusted.
 *
 * Throws `AppError.authentication`. Expiry is reported distinctly from
 * "invalid" so a client knows to attempt a refresh rather than a full
 * re-login — that distinction leaks nothing about *who* the user is.
 */
export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, accessSecret, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: [ALGORITHM],
    });

    const { sub, sid, role, jti } = payload as Partial<AccessTokenClaims>;

    // A structurally valid but incomplete token is not usable as identity.
    if (!sub || !sid || !role || !jti) {
      throw AppError.authentication("Invalid access token");
    }

    return { sub, sid, role, jti };
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) {
      throw AppError.authentication("Access token has expired");
    }
    if (error instanceof AppError) {
      throw error;
    }
    throw AppError.authentication("Invalid access token");
  }
}
