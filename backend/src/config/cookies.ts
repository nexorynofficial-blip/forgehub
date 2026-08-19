import type { CookieOptions, Response } from "express";

import { env, isProduction } from "./env.js";
import { logger } from "../utils/logger.js";

/**
 * Cookie transport for the refresh token and the 2FA challenge.
 *
 * The refresh token lives *only* here — never in a JSON response body. That
 * is the point of the split: the access token is short-lived and held in
 * memory by the client, while the long-lived credential is `httpOnly` and
 * therefore unreadable by any script, including injected ones.
 */

/** `Secure` is environment-driven, defaulting to on in production only. */
const secure = env.COOKIE_SECURE ?? isProduction;

if (env.COOKIE_SAMESITE === "none" && !secure) {
  // Browsers silently drop `SameSite=None` cookies that are not `Secure`, so
  // this combination would break refresh with no visible error.
  logger.warn(
    "COOKIE_SAMESITE=none requires COOKIE_SECURE=true — browsers will reject the refresh cookie",
  );
}

function baseOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure,
    sameSite: env.COOKIE_SAMESITE,
    // Scoped so the credential is only sent to the endpoints that consume it,
    // rather than riding along on every authenticated API request.
    path: env.AUTH_COOKIE_PATH,
    // `exactOptionalPropertyTypes` — only set the key when a value exists.
    ...(env.COOKIE_DOMAIN !== undefined ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}

export function setRefreshCookie(res: Response, token: string, maxAgeMs: number): void {
  res.cookie(env.REFRESH_COOKIE_NAME, token, { ...baseOptions(), maxAge: maxAgeMs });
}

/**
 * Clearing must repeat path/domain/sameSite/secure exactly — a browser treats
 * a cookie with a different path as a different cookie and leaves the
 * original in place.
 */
export function clearRefreshCookie(res: Response): void {
  res.clearCookie(env.REFRESH_COOKIE_NAME, baseOptions());
}

export function setTwoFactorChallengeCookie(res: Response, token: string): void {
  res.cookie(env.TWO_FACTOR_COOKIE_NAME, token, {
    ...baseOptions(),
    maxAge: env.TWO_FACTOR_CHALLENGE_TTL_SECONDS * 1_000,
  });
}

export function clearTwoFactorChallengeCookie(res: Response): void {
  res.clearCookie(env.TWO_FACTOR_COOKIE_NAME, baseOptions());
}

/** Cookie names, exported so tests and the OpenAPI document stay in sync. */
export const cookieNames = {
  refresh: env.REFRESH_COOKIE_NAME,
  twoFactor: env.TWO_FACTOR_COOKIE_NAME,
} as const;
