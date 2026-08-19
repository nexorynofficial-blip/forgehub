import type { ModerationStatus, UserRole } from "@prisma/client";

/**
 * Contracts for the auth module.
 *
 * `AuthUserView` is the only user shape this phase serves. It deliberately
 * stops short of the frontend's full `User` type (`src/types/user.ts`):
 * achievements, badges, counters, and reputation belong to the users/profiles
 * module in Phase 4. What is here is the subset the shipped UI needs to
 * render an authenticated shell — `UserMenu` (avatar, displayName, username)
 * and `AdminGuard` (role).
 */
export interface AuthUserView {
  id: string;
  email: string;
  username: string;
  displayName: string;
  role: UserRole;
  status: ModerationStatus;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  avatarUrl: string | null;
  bannerUrl: string | null;
  bio: string;
  createdAt: string;
}

/**
 * What a successful authentication produces.
 *
 * `refreshToken` never reaches a JSON body — the controller moves it straight
 * into an httpOnly cookie. It is on this type only because the service, not
 * the controller, is what mints it.
 */
export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  /** Cookie `maxAge`, derived from the remember-me choice. */
  refreshMaxAgeMs: number;
  sessionId: string;
}

export interface AuthenticatedResult {
  status: "authenticated";
  user: AuthUserView;
  tokens: IssuedTokens;
}

/**
 * Password was correct but the account has 2FA enabled, so no tokens are
 * issued yet. The challenge token is a short-lived, single-purpose credential
 * that only `/auth/2fa/challenge` accepts.
 */
export interface TwoFactorRequiredResult {
  status: "two_factor_required";
  challengeToken: string;
}

export type LoginResult = AuthenticatedResult | TwoFactorRequiredResult;

/** A device session, as shown in Settings → Security. */
export interface SessionView {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  /** True for the session the requesting access token belongs to. */
  current: boolean;
}

/** Returned once, at enrollment. The secret is never readable again. */
export interface TwoFactorEnrollment {
  /** Base32 secret, for manual entry into an authenticator app. */
  secret: string;
  /** `otpauth://` URI the frontend renders as a QR code. */
  otpauthUrl: string;
}

/** Request context captured for sessions and audit records. */
export interface RequestContext {
  ipAddress: string | null;
  userAgent: string | null;
}
