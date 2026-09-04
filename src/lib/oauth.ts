import { API_BASE_URL, GOOGLE_OAUTH_ENABLED } from "@/lib/env";

/**
 * The client side of federated sign-in.
 *
 * There is almost nothing to it, and that is the design: the browser
 * navigates to a backend route, the backend owns the entire conversation with
 * Google, and the browser comes back to a page that calls `refreshSession()`
 * like any other reload. No client id, no provider token, and no SDK ever
 * reaches this bundle.
 */

export { GOOGLE_OAUTH_ENABLED };

/**
 * Where the Google button sends the browser.
 *
 * A full-page navigation, never `fetch`: the user has to *see* Google's
 * account chooser and consent screen, and an XHR to a cross-origin redirect
 * would be blocked long before it got there.
 */
export function googleSignInUrl(next?: string): string {
  const url = new URL(`${API_BASE_URL}/auth/google`);
  const destination = safeInternalPath(next);

  if (destination !== null) url.searchParams.set("next", destination);

  return url.toString();
}

/**
 * Returns the value as an internal path, or `null`.
 *
 * The backend validates this too — it is the side that matters, because a
 * request can be made without going near this code. This copy exists for the
 * other direction: the completion page reads `next` back out of a URL the
 * user could have edited, and hands it to the router. Both ends of the round
 * trip check, because both ends can be the one that is attacked.
 */
export function safeInternalPath(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();

  if (trimmed.length === 0 || trimmed.length > 512) return null;
  if (!trimmed.startsWith("/")) return null;
  // Protocol-relative, and the backslash form browsers normalise into it.
  if (trimmed.startsWith("//") || trimmed.startsWith("/\\")) return null;

  try {
    // An unreachable base (RFC 2606): anything carrying its own origin or
    // scheme resolves away from it and is rejected.
    const base = "http://redirect-base.invalid";
    const parsed = new URL(trimmed, base);
    if (parsed.origin !== base) return null;

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

/**
 * What each failure code from the backend means, in the user's terms.
 *
 * The codes are a closed set (`auth.service.ts`, `OAuthError`) and nothing
 * else crosses in the URL — no provider response, no internal message, no
 * stack. An unrecognised code therefore means the two sides have drifted, and
 * gets the generic line rather than being echoed to the screen.
 */
const OAUTH_ERRORS: Record<string, string> = {
  oauth_unavailable: "Google sign-in isn't available right now. Try email and password.",
  oauth_cancelled: "Google sign-in was cancelled.",
  oauth_state_invalid:
    "That sign-in link expired or was already used. Please start again.",
  oauth_exchange_failed: "We couldn't finish signing you in with Google. Please retry.",
  oauth_identity_invalid: "Google didn't return a usable identity. Please retry.",
  oauth_email_unverified:
    "Google hasn't verified that email address. Verify it with Google, then try again.",
  oauth_account_unverified:
    "An account already uses this address but hasn't confirmed it yet. Check your inbox for the verification link, or sign in with your password.",
  oauth_account_conflict:
    "This address is already linked to a different Google account. Sign in with your password instead.",
  oauth_account_suspended: "This account can't be signed into. Contact support.",
};

const GENERIC_OAUTH_ERROR = "We couldn't sign you in with Google. Please try again.";

export function oauthErrorMessage(code: string | null | undefined): string {
  if (typeof code !== "string") return GENERIC_OAUTH_ERROR;
  return OAUTH_ERRORS[code] ?? GENERIC_OAUTH_ERROR;
}
