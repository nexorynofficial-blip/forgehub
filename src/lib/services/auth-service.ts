import type { UserRole } from "@/types";
import { api, clearAccessToken, refreshSession, setAccessToken } from "@/lib/api";
import type {
  LoginValues,
  ResetPasswordValues,
  SignupValues,
} from "@/lib/validations/auth";

/**
 * The Authentication API (`backend/src/modules/auth`).
 *
 * ## The session user is not the profile user
 *
 * `/auth/*` returns the backend's `AuthUserView` — a deliberately lean shell
 * (identity, role, status, avatar) whose own comment says it exists to render
 * `UserMenu` and an admin guard. The rich `User` in `src/types/user.ts` is the
 * *profile* view served by `/users/me`, and wiring that is Phase 2's job. Two
 * names for two genuinely different payloads, so neither type has to lie.
 */
export interface SessionUser {
  id: string;
  email: string;
  username: string;
  displayName: string;
  role: UserRole;
  status: "active" | "banned" | "shadow_banned";
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  avatarUrl: string | null;
  bannerUrl: string | null;
  bio: string;
  createdAt: string;
}

/** What the backend puts in `data` for login / refresh / 2FA success. */
interface AuthenticatedPayload {
  user: SessionUser;
  accessToken: string;
  /**
   * The *refresh cookie's* lifetime (7d, or 30d with "remember me") — not the
   * 15-minute access token's. Nothing here schedules a refresh from it; the
   * client refreshes reactively when a request comes back 401.
   */
  expiresIn: number;
}

/** Login either authenticates outright or stops for a second factor. */
export type LoginResult =
  { status: "authenticated"; user: SessionUser } | { status: "two_factor_required" };

/** The 2FA branch, as `respondLoginResult` in the backend controller emits it. */
interface TwoFactorRequiredPayload {
  twoFactorRequired: true;
  challengeToken: string;
}

function isTwoFactorRequired(
  payload: AuthenticatedPayload | TwoFactorRequiredPayload,
): payload is TwoFactorRequiredPayload {
  return "twoFactorRequired" in payload;
}

/** Narrows the wire payload; also the single place the token is stored. */
function acceptSession(payload: AuthenticatedPayload): SessionUser {
  setAccessToken(payload.accessToken);
  return payload.user;
}

/** The refresh payload types `user` as `unknown` to keep domain types out of
 * the transport layer; this is the one place it is given its real shape. */
export function toSessionUser(user: unknown): SessionUser {
  return user as SessionUser;
}

/* ── Sign in ──────────────────────────────────────────────────────────────── */

/**
 * `POST /auth/login`.
 *
 * The backend's `loginSchema` accepts `{ email, password, rememberMe }` — the
 * frontend's `LoginValues` verbatim — so the form's values post unmodified.
 */
export async function login(values: LoginValues): Promise<LoginResult> {
  const payload = await api.post<AuthenticatedPayload | TwoFactorRequiredPayload>(
    "/auth/login",
    values,
  );

  if (isTwoFactorRequired(payload)) {
    // No token is stored: the user is not authenticated until the second
    // factor clears. The challenge itself rides in an httpOnly cookie.
    return { status: "two_factor_required" };
  }

  return { status: "authenticated", user: acceptSession(payload) };
}

/**
 * `POST /auth/2fa/challenge`.
 *
 * The challenge token lives in an httpOnly cookie set at login, which the
 * browser attaches automatically (the client always sends credentials), so
 * only the code goes in the body. `twoFactorChallengeSchema` accepts either a
 * `code` or a `backupCode` and rejects both at once.
 */
export async function verifyTwoFactorCode(code: string): Promise<SessionUser> {
  const payload = await api.post<AuthenticatedPayload>("/auth/2fa/challenge", { code });
  return acceptSession(payload);
}

/* ── Registration ─────────────────────────────────────────────────────────── */

/**
 * What `POST /auth/register` actually returns.
 *
 * Registration does **not** sign the user in: the backend answers 201 with
 * `{ email, verificationRequired: true }` and no token, and returns that same
 * body whether or not the address was already taken (so the endpoint cannot be
 * used to enumerate accounts). The existing signup form already routes to the
 * verify-email screen, which is exactly right.
 */
export interface SignupResult {
  email: string;
  verificationRequired: boolean;
}

/** `registerSchema` accepts `confirmPassword` and `agreeToTerms` too. */
export async function signup(values: SignupValues): Promise<SignupResult> {
  return api.post<SignupResult>("/auth/register", values);
}

/* ── Password & email ─────────────────────────────────────────────────────── */

/** `POST /auth/password/forgot`. Answers identically for unknown addresses. */
export async function requestPasswordReset(email: string): Promise<{ success: true }> {
  await api.post("/auth/password/forgot", { email });
  return { success: true };
}

/** `POST /auth/verify-email/resend`. */
export async function resendVerificationEmail(email: string): Promise<{ success: true }> {
  await api.post("/auth/verify-email/resend", { email });
  return { success: true };
}

/**
 * `POST /auth/password/reset` — the second half of the forgot-password flow.
 *
 * The token comes from the emailed link (`APP_URL/reset-password?token=…`),
 * not from anything the user types, and `confirmPassword` is sent because the
 * backend re-checks the match itself rather than trusting the client to have.
 *
 * Completing a reset **revokes every session**, including any this browser
 * held, and the backend clears the refresh cookie in the same response. Any
 * access token still in memory is therefore already dead, so the local one is
 * cleared here rather than left to fail on the next request.
 */
export async function resetPassword(values: ResetPasswordValues): Promise<void> {
  await api.post("/auth/password/reset", values);
  clearAccessToken();
}

/**
 * `POST /auth/verify-email` — the second half of the sign-up flow.
 *
 * The verification link lands on `/verify-email?token=…`; this is what turns
 * that arrival into a verified account. It deliberately does **not** sign the
 * user in: the backend answers with the user record and no access token, so
 * the next step is the login screen.
 */
export async function verifyEmail(token: string): Promise<SessionUser> {
  const { user } = await api.post<{ user: SessionUser }>("/auth/verify-email", { token });
  return user;
}

/* ── Session lifecycle ────────────────────────────────────────────────────── */

/**
 * `POST /auth/logout` — public, and reads the refresh cookie rather than the
 * access token, so it still works once the access token has expired.
 *
 * The local token is cleared in `finally`: if the network call fails, the one
 * credential this tab holds must still go away.
 */
export async function logout(): Promise<void> {
  try {
    await api.post("/auth/logout");
  } finally {
    clearAccessToken();
  }
}

/**
 * Re-establishes the session on a cold page load.
 *
 * The access token is memory-only and therefore gone after a reload; the
 * refresh cookie is what proves the session survived. Returns `null` when
 * there is no live session — an expected outcome, not an error.
 */
export async function bootstrapSession(): Promise<SessionUser | null> {
  const payload = await refreshSession();
  return payload ? toSessionUser(payload.user) : null;
}
