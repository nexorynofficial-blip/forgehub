/**
 * The handful of frontend paths the backend has to know.
 *
 * The OAuth flow is the only one where this server decides where a *browser*
 * goes next, so these three constants are the whole set. They are named here
 * rather than written inline so the coupling is visible in one place: change
 * a route in `src/lib/routes.ts` and this file is what has to change with it.
 *
 * Paths only — the origin is `APP_URL`, which a deployment already configures
 * for the verification and password-reset links.
 */

/** Where every Google sign-in outcome lands, success or failure. */
export const OAUTH_COMPLETION_PATH = "/auth/google/callback";

/** The existing two-factor page, reused unchanged by the provider flow. */
export const TWO_FACTOR_PATH = "/2fa";

/** Where the sign-in form lives. */
export const LOGIN_PATH = "/login";
