/**
 * The access token, and nothing else.
 *
 * ## Why memory only
 *
 * The backend deliberately splits the two credentials (`backend/src/config/
 * cookies.ts`): the refresh token is `httpOnly` and unreadable by any script,
 * while the access token is short-lived and returned in the JSON body. Writing
 * the access token to `localStorage` or a cookie would throw away exactly the
 * property that split buys — a script that can run in this page could read it.
 *
 * So it lives in a module variable. It does not survive a reload, and it is
 * not supposed to: `AuthProvider` re-establishes the session on startup by
 * spending the refresh cookie instead.
 *
 * This module imports nothing. That is what lets the API client and the auth
 * provider share state without importing each other.
 */

let accessToken: string | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string): void {
  accessToken = token;
}

export function clearAccessToken(): void {
  accessToken = null;
}

/* ── Session-expiry seam ──────────────────────────────────────────────────── */

type SessionExpiredHandler = () => void;

let sessionExpiredHandler: SessionExpiredHandler | null = null;

/**
 * Lets the auth provider learn that the session died without the API client
 * having to import it.
 *
 * The client is the only code that can detect a *failed refresh*, but React
 * state is the provider's business. A one-way callback keeps the dependency
 * arrow pointing provider → client and avoids an import cycle.
 */
export function setSessionExpiredHandler(handler: SessionExpiredHandler | null): void {
  sessionExpiredHandler = handler;
}

/** Called by the client after a refresh attempt fails. Never throws. */
export function notifySessionExpired(): void {
  sessionExpiredHandler?.();
}
