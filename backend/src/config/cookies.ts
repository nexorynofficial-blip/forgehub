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

/* ── OAuth state ────────────────────────────────────────────────────────── */

/**
 * The OAuth callback is a **cross-site top-level navigation**: Google issues
 * the redirect, so as far as the browser is concerned the request originates
 * from accounts.google.com. `SameSite=Strict` withholds a cookie on exactly
 * that request, which would make every sign-in fail its state check with no
 * visible cause — so a deployment that chose `strict` gets `lax` here, which
 * is the strictest setting that survives the round trip. `none` is left alone:
 * it is what a cross-origin frontend needs, and it is already paired with
 * `Secure`.
 */
const oauthSameSite = env.COOKIE_SAMESITE === "strict" ? "lax" : env.COOKIE_SAMESITE;

/**
 * Scoped to the OAuth routes alone — narrower than `AUTH_COOKIE_PATH`, so this
 * short-lived value is not attached to `/refresh`, `/logout`, or any other
 * credential endpoint that has no business seeing it.
 */
const oauthStatePath = env.AUTH_COOKIE_PATH.endsWith("/")
  ? `${env.AUTH_COOKIE_PATH}google`
  : `${env.AUTH_COOKIE_PATH}/google`;

function oauthStateOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure,
    sameSite: oauthSameSite,
    path: oauthStatePath,
    ...(env.COOKIE_DOMAIN !== undefined ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}

export function setOAuthStateCookie(
  res: Response,
  state: string,
  maxAgeMs: number,
): void {
  res.cookie(env.OAUTH_STATE_COOKIE_NAME, state, {
    ...oauthStateOptions(),
    maxAge: maxAgeMs,
  });
}

/** Called on every callback, success or failure — the state is single-use. */
export function clearOAuthStateCookie(res: Response): void {
  res.clearCookie(env.OAUTH_STATE_COOKIE_NAME, oauthStateOptions());
}

/** Cookie names, exported so tests and the OpenAPI document stay in sync. */
export const cookieNames = {
  refresh: env.REFRESH_COOKIE_NAME,
  twoFactor: env.TWO_FACTOR_COOKIE_NAME,
  oauthState: env.OAUTH_STATE_COOKIE_NAME,
} as const;

/** Exported for the deployment tests, which assert the scoping above. */
export const cookiePaths = {
  auth: env.AUTH_COOKIE_PATH,
  oauthState: oauthStatePath,
} as const;
