import { Prisma } from "@prisma/client";

import { env } from "../../config/env.js";
import { redis } from "../../config/redis.js";
import { emailService } from "../../integrations/email/index.js";
import { AuditAction, recordAuditEvent, type AuditContext } from "../../utils/audit.js";
import {
  assertNotLockedOut,
  clearFailedAttempts,
  recordFailedAttempt,
} from "../../utils/brute-force.js";
import { decryptSecret, encryptSecret } from "../../utils/crypto.js";
import { AppError } from "../../utils/errors.js";
import { signAccessToken } from "../../utils/jwt.js";
import { logger } from "../../utils/logger.js";
import {
  expiryFrom,
  generateBackupCodes,
  generateOpaqueToken,
  hashBackupCode,
  hashToken,
  parseDuration,
} from "../../utils/tokens.js";
import { buildOtpauthUrl, generateTotpSecret, verifyTotp } from "../../utils/totp.js";
import {
  pickAvailableUsername,
  randomUsername,
  usernameBase,
} from "../../utils/username.js";
import {
  hashPassword,
  verifyPassword,
  verifyPasswordAgainstDummy,
} from "../../utils/password.js";
import * as repo from "./auth.repository.js";
import type {
  AuthUserView,
  IssuedTokens,
  LoginResult,
  RequestContext,
  SessionView,
  TwoFactorEnrollment,
} from "./auth.types.js";
import type { ChangePasswordInput, LoginInput, RegisterInput } from "./auth.schema.js";

/**
 * Authentication business logic (BACKEND_ARCHITECTURE.md §17–18).
 *
 * Owns every authorization decision and all orchestration; touches Prisma
 * only through `auth.repository.ts`. Controllers below this call these
 * methods and do nothing else.
 *
 * Two rules shape most of what looks unusual in here:
 *
 *   1. **No user enumeration.** Failure responses are identical whether or
 *      not an account exists, and the unknown-account path deliberately burns
 *      the same Argon2 work as the real one.
 *   2. **Credentials are never returned or logged.** `passwordHash`, TOTP
 *      secrets, backup-code digests, and raw tokens never leave this layer
 *      except where a flow requires it exactly once (enrollment).
 */

/** One message for every credential failure — see rule 1 above. */
const INVALID_CREDENTIALS = "Invalid email or password";

/* ── Views ──────────────────────────────────────────────────────────────── */

function toAuthUserView(user: repo.UserWithProfile): AuthUserView {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    emailVerified: user.emailVerified,
    twoFactorEnabled: user.twoFactor?.enabled ?? false,
    avatarUrl: user.profile?.avatarUrl ?? null,
    bannerUrl: user.profile?.bannerUrl ?? null,
    bio: user.profile?.bio ?? "",
    createdAt: user.createdAt.toISOString(),
  };
}

/* ── Token issuance ─────────────────────────────────────────────────────── */

/**
 * Mints a session, its first refresh token, and an access token.
 *
 * The session's `expiresAt` is an **absolute** cap: rotated refresh tokens
 * inherit it rather than extending it, so a stolen token chain cannot be kept
 * alive indefinitely by refreshing. "Remember me" chooses which cap applies
 * (30d vs 7d), not whether one exists.
 */
async function issueTokens(
  user: { id: string; role: repo.UserRole },
  context: RequestContext,
  rememberMe: boolean,
): Promise<IssuedTokens> {
  const lifetime = rememberMe
    ? env.JWT_REFRESH_REMEMBER_EXPIRES
    : env.JWT_REFRESH_EXPIRES;
  const expiresAt = expiryFrom(lifetime);

  const session = await repo.createSession({
    userId: user.id,
    userAgent: context.userAgent,
    ipAddress: context.ipAddress,
    expiresAt,
  });

  const refreshToken = generateOpaqueToken();
  await repo.createRefreshToken({
    sessionId: session.id,
    tokenHash: hashToken(refreshToken),
    expiresAt,
  });

  const accessToken = await signAccessToken({
    userId: user.id,
    sessionId: session.id,
    role: user.role,
  });

  return {
    accessToken,
    refreshToken,
    refreshMaxAgeMs: parseDuration(lifetime),
    sessionId: session.id,
  };
}

/* ── Two-factor challenge store ─────────────────────────────────────────── */

/**
 * A half-completed login lives in Redis, not Postgres: it is worthless after
 * five minutes and writing it to durable storage would leave a table of
 * password-verified-but-unfinished logins to prune (ARCHITECTURE §19).
 */
interface ChallengePayload {
  userId: string;
  rememberMe: boolean;
}

function challengeKey(token: string): string {
  return `2fa:challenge:${hashToken(token)}`;
}

async function createTwoFactorChallenge(payload: ChallengePayload): Promise<string> {
  const token = generateOpaqueToken();
  await redis.set(
    challengeKey(token),
    JSON.stringify(payload),
    "EX",
    env.TWO_FACTOR_CHALLENGE_TTL_SECONDS,
  );
  return token;
}

async function readTwoFactorChallenge(token: string): Promise<ChallengePayload | null> {
  const raw = await redis.get(challengeKey(token));
  if (!raw) return null;

  try {
    return JSON.parse(raw) as ChallengePayload;
  } catch {
    return null;
  }
}

async function consumeTwoFactorChallenge(token: string): Promise<void> {
  await redis.del(challengeKey(token));
}

/* ── Registration ───────────────────────────────────────────────────────── */

export interface RegisterResult {
  email: string;
  verificationRequired: true;
}

/**
 * Issues a fresh verification token, invalidating any outstanding one so a
 * link from an earlier email cannot be replayed.
 */
async function sendVerificationEmail(user: {
  id: string;
  email: string;
  displayName: string;
}): Promise<void> {
  await repo.invalidateEmailVerificationTokens(user.id);

  const token = generateOpaqueToken();
  await repo.createEmailVerificationToken({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt: expiryFrom(env.EMAIL_VERIFICATION_EXPIRES),
  });

  await emailService.sendVerificationEmail(user.email, {
    displayName: user.displayName,
    token,
  });
}

/**
 * Creates the account, retrying username collisions against the unique index.
 *
 * The precomputed candidate can lose a race with a concurrent registration —
 * that is why the loop exists. `P2002` on `username` means someone else took
 * the handle between our read and our write, so we pick another and try
 * again; `P2002` on `email` is a genuine duplicate and is re-thrown for the
 * caller to handle. The database constraint, not the lookup, is what
 * guarantees uniqueness.
 */
async function createUserWithUniqueUsername(input: {
  email: string;
  displayName: string;
  passwordHash: string;
}): Promise<repo.UserWithProfile> {
  const base = usernameBase(input.displayName);
  const taken = await repo.findUsernamesStartingWith(base);
  let candidate = pickAvailableUsername(base, taken);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await repo.createUser({ ...input, username: candidate });
    } catch (error) {
      const target =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
          ? String(error.meta?.["target"] ?? "")
          : null;

      if (target === null || !target.includes("username")) throw error;

      candidate = randomUsername(base);
    }
  }

  throw AppError.internal("Could not allocate a unique username");
}

/**
 * Registers an account.
 *
 * **Responds identically whether or not the email is already registered.**
 * A 409 here would turn signup into an account-existence oracle, which J6
 * forbids; instead the existing owner receives a "someone tried to register
 * with your address" email and no second account is created. The shipped
 * signup form navigates to /verify-email on success either way, so the UX is
 * unchanged. (Flip this to a `CONFLICT` in one place if the tradeoff is ever
 * revisited — see docs/AUTHENTICATION.md.)
 */
export async function register(
  input: RegisterInput,
  context: RequestContext,
): Promise<RegisterResult> {
  const identical: RegisterResult = {
    email: input.email,
    verificationRequired: true,
  };

  // Keyed on the source address, not the email: keying on the email would let
  // an attacker lock a victim out of ever registering.
  await assertNotLockedOut("register", context.ipAddress ?? "unknown");

  const existing = await repo.findCredentialsByEmail(input.email);

  if (existing) {
    await recordFailedAttempt("register", context.ipAddress ?? "unknown");
    await emailService.sendSecurityAlertEmail(existing.email, {
      displayName: existing.displayName,
      event: "an attempt to create a new account with your email address",
    });
    return identical;
  }

  const passwordHash = await hashPassword(input.password);
  const user = await createUserWithUniqueUsername({
    email: input.email,
    displayName: input.displayName,
    passwordHash,
  });

  await sendVerificationEmail(user);

  await recordAuditEvent({
    ...context,
    actorId: user.id,
    action: AuditAction.USER_REGISTERED,
    targetType: "user",
    targetId: user.id,
    metadata: { username: user.username },
  });

  // The signup form's `agreeToTerms` has no column on `users` and adding one
  // would need a migration, so acceptance is recorded here — an append-only
  // record is arguably the better home for a legal attestation anyway.
  await recordAuditEvent({
    ...context,
    actorId: user.id,
    action: AuditAction.TERMS_ACCEPTED,
    targetType: "user",
    targetId: user.id,
  });

  return identical;
}

/* ── Login ──────────────────────────────────────────────────────────────── */

export async function login(
  input: LoginInput,
  context: RequestContext,
): Promise<LoginResult> {
  await assertNotLockedOut("login", input.email);

  const user = await repo.findCredentialsByEmail(input.email);

  // Unknown account: still pay the Argon2 cost. Skipping it would make the
  // "no such user" path measurably faster than "wrong password", which is a
  // timing oracle for valid addresses.
  if (!user?.passwordHash) {
    await verifyPasswordAgainstDummy(input.password);
    await onFailedLogin(input.email, null, context);
    throw AppError.authentication(INVALID_CREDENTIALS);
  }

  const passwordValid = await verifyPassword(user.passwordHash, input.password);

  if (!passwordValid) {
    await onFailedLogin(input.email, user.id, context);
    throw AppError.authentication(INVALID_CREDENTIALS);
  }

  // Checked only *after* the password verifies. At this point the caller
  // already proved they own the account, so a specific message reveals
  // nothing they did not know — and a generic one would be actively unhelpful.
  if ((await repo.liftExpiredSuspension(user.id, user.status)) === "banned") {
    throw AppError.authorization("This account has been suspended");
  }

  await clearFailedAttempts("login", input.email);

  if (user.twoFactor?.enabled === true) {
    const challengeToken = await createTwoFactorChallenge({
      userId: user.id,
      rememberMe: input.rememberMe,
    });
    return { status: "two_factor_required", challengeToken };
  }

  return finalizeLogin(user, context, input.rememberMe);
}

async function onFailedLogin(
  email: string,
  userId: string | null,
  context: RequestContext,
): Promise<void> {
  const lockSeconds = await recordFailedAttempt("login", email);

  await recordAuditEvent({
    ...context,
    actorId: userId,
    action: AuditAction.USER_LOGIN_FAILED,
    ...(userId !== null ? { targetType: "user" as const, targetId: userId } : {}),
  });

  if (lockSeconds > 0) {
    await recordAuditEvent({
      ...context,
      actorId: userId,
      action: AuditAction.ACCOUNT_LOCKED,
      metadata: { lockSeconds },
    });
  }
}

/** Shared tail of both the direct and 2FA-completed login paths. */
async function finalizeLogin(
  user: repo.UserWithProfile,
  context: RequestContext,
  rememberMe: boolean,
): Promise<LoginResult> {
  const tokens = await issueTokens(user, context, rememberMe);
  await repo.touchLastActive(user.id);

  await recordAuditEvent({
    ...context,
    actorId: user.id,
    action: AuditAction.USER_LOGIN,
    targetType: "user",
    targetId: user.id,
    metadata: { sessionId: tokens.sessionId, rememberMe },
  });

  return { status: "authenticated", user: toAuthUserView(user), tokens };
}

/* ── Refresh ────────────────────────────────────────────────────────────── */

export interface RefreshResult {
  tokens: IssuedTokens;
  user: AuthUserView;
}

/**
 * Rotates a refresh token (TRD §13).
 *
 * The reuse branch is the security-critical part. A refresh token is
 * single-use: presenting one that has already been rotated away means either
 * a client bug or — far more likely — that the token was stolen and the
 * legitimate client already spent it. Either way the safe response is to
 * revoke the entire session, forcing a real re-authentication, rather than
 * quietly issuing a fresh pair to whoever asked.
 */
export async function refresh(
  rawToken: string,
  context: RequestContext,
): Promise<RefreshResult> {
  const record = await repo.findRefreshTokenByHash(hashToken(rawToken));

  if (!record) {
    throw AppError.authentication("Invalid refresh token");
  }

  if (record.revokedAt !== null) {
    await repo.revokeSession(record.sessionId);

    logger.warn(
      { sessionId: record.sessionId },
      "Refresh token reuse detected — session revoked",
    );
    await recordAuditEvent({
      ...context,
      actorId: record.session.userId,
      action: AuditAction.REFRESH_TOKEN_REUSE_DETECTED,
      targetType: "user",
      targetId: record.session.userId,
      metadata: { sessionId: record.sessionId },
    });

    throw AppError.authentication("Refresh token is no longer valid");
  }

  const now = new Date();
  const { session } = record;

  if (record.expiresAt <= now || session.revokedAt !== null || session.expiresAt <= now) {
    throw AppError.authentication("Refresh token is no longer valid");
  }

  const user = await repo.findProfileById(session.userId);

  if (!user) {
    throw AppError.authentication("Refresh token is no longer valid");
  }

  if ((await repo.liftExpiredSuspension(user.id, user.status)) === "banned") {
    await repo.revokeSession(session.id);
    throw AppError.authorization("This account has been suspended");
  }

  const nextToken = generateOpaqueToken();
  await repo.rotateRefreshToken({
    currentTokenId: record.id,
    sessionId: session.id,
    nextTokenHash: hashToken(nextToken),
    // Inherit the session's absolute expiry rather than extending it.
    expiresAt: session.expiresAt,
  });
  await repo.touchSession(session.id);

  const accessToken = await signAccessToken({
    userId: user.id,
    sessionId: session.id,
    role: user.role,
  });

  await recordAuditEvent({
    ...context,
    actorId: user.id,
    action: AuditAction.TOKEN_REFRESHED,
    targetType: "user",
    targetId: user.id,
    metadata: { sessionId: session.id },
  });

  return {
    user: toAuthUserView(user),
    tokens: {
      accessToken,
      refreshToken: nextToken,
      refreshMaxAgeMs: Math.max(0, session.expiresAt.getTime() - now.getTime()),
      sessionId: session.id,
    },
  };
}

/* ── Logout ─────────────────────────────────────────────────────────────── */

/**
 * Revokes the session behind the presented refresh token.
 *
 * Tolerant by design: logging out with an already-invalid token still
 * succeeds, because the caller's intent (be signed out) is satisfied and
 * returning an error would only strand a client with a stale cookie.
 */
export async function logout(
  rawToken: string | null,
  context: RequestContext,
  sessionIdFromAccessToken?: string,
): Promise<void> {
  let sessionId = sessionIdFromAccessToken ?? null;
  let userId: string | null = null;

  if (rawToken) {
    const record = await repo.findRefreshTokenByHash(hashToken(rawToken));
    if (record) {
      sessionId = record.sessionId;
      userId = record.session.userId;
    }
  }

  if (sessionId) {
    await repo.revokeSession(sessionId);
    await recordAuditEvent({
      ...context,
      actorId: userId,
      action: AuditAction.USER_LOGOUT,
      metadata: { sessionId },
    });
  }
}

/* ── Current user ───────────────────────────────────────────────────────── */

export async function getCurrentUser(userId: string): Promise<AuthUserView> {
  const user = await repo.findProfileById(userId);

  if (!user) {
    throw AppError.authentication("Session is no longer valid");
  }

  return toAuthUserView(user);
}

/* ── Email verification ─────────────────────────────────────────────────── */

export async function verifyEmail(
  token: string,
  context: RequestContext,
): Promise<AuthUserView> {
  const record = await repo.findEmailVerificationToken(hashToken(token));

  if (!record || record.usedAt !== null || record.expiresAt <= new Date()) {
    throw AppError.validation("This verification link is invalid or has expired");
  }

  // Atomic single-use: two concurrent clicks cannot both consume the token.
  const consumed = await repo.consumeEmailVerificationToken(record.id);
  if (!consumed) {
    throw AppError.validation("This verification link is invalid or has expired");
  }

  await repo.markEmailVerified(record.userId);

  await recordAuditEvent({
    ...context,
    actorId: record.userId,
    action: AuditAction.EMAIL_VERIFIED,
    targetType: "user",
    targetId: record.userId,
  });

  return getCurrentUser(record.userId);
}

/**
 * Always reports success. Whether an email exists, and whether it is already
 * verified, are both facts this endpoint refuses to disclose.
 */
export async function resendVerification(
  email: string,
  context: RequestContext,
): Promise<void> {
  await assertNotLockedOut("email-verification", email);
  // Counted on every request, not just failures — this scope throttles volume
  // rather than guesses.
  await recordFailedAttempt("email-verification", email);

  const user = await repo.findCredentialsByEmail(email);

  if (!user || user.emailVerified) return;

  await sendVerificationEmail(user);

  await recordAuditEvent({
    ...context,
    actorId: user.id,
    action: AuditAction.EMAIL_VERIFICATION_SENT,
    targetType: "user",
    targetId: user.id,
  });
}

/* ── Password reset ─────────────────────────────────────────────────────── */

/** Always reports success — see `resendVerification`. */
export async function forgotPassword(
  email: string,
  context: RequestContext,
): Promise<void> {
  await assertNotLockedOut("password-reset", email);
  await recordFailedAttempt("password-reset", email);

  const user = await repo.findCredentialsByEmail(email);
  if (!user) return;

  await repo.invalidatePasswordResetTokens(user.id);

  const token = generateOpaqueToken();
  await repo.createPasswordResetToken({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt: expiryFrom(env.PASSWORD_RESET_EXPIRES),
  });

  await emailService.sendPasswordResetEmail(user.email, {
    displayName: user.displayName,
    token,
  });

  await recordAuditEvent({
    ...context,
    actorId: user.id,
    action: AuditAction.PASSWORD_RESET_REQUESTED,
    targetType: "user",
    targetId: user.id,
  });
}

/**
 * Completes a reset and signs every device out.
 *
 * Revoking all sessions is the point: a reset is what someone does when they
 * believe their account is compromised, so leaving the attacker's existing
 * session alive would defeat the exercise.
 */
export async function resetPassword(
  token: string,
  newPassword: string,
  context: RequestContext,
): Promise<void> {
  const record = await repo.findPasswordResetToken(hashToken(token));

  if (!record || record.usedAt !== null || record.expiresAt <= new Date()) {
    throw AppError.validation("This reset link is invalid or has expired");
  }

  const consumed = await repo.consumePasswordResetToken(record.id);
  if (!consumed) {
    throw AppError.validation("This reset link is invalid or has expired");
  }

  const user = await repo.findCredentialsById(record.userId);
  if (!user) {
    throw AppError.validation("This reset link is invalid or has expired");
  }

  await repo.updatePasswordHash(user.id, await hashPassword(newPassword));
  const revoked = await repo.revokeAllSessions(user.id);

  await recordAuditEvent({
    ...context,
    actorId: user.id,
    action: AuditAction.PASSWORD_RESET_COMPLETED,
    targetType: "user",
    targetId: user.id,
    metadata: { sessionsRevoked: revoked },
  });

  await emailService.sendSecurityAlertEmail(user.email, {
    displayName: user.displayName,
    event: "your password was reset",
  });
}

/**
 * Changes a password for a signed-in user.
 *
 * Keeps the *current* session alive and revokes the rest — the person making
 * the change should not be logged out of the tab they are using, but any
 * other device holding a session established with the old password should be.
 */
export async function changePassword(
  userId: string,
  currentSessionId: string,
  input: ChangePasswordInput,
  context: RequestContext,
): Promise<void> {
  const user = await repo.findCredentialsById(userId);

  if (!user?.passwordHash) {
    throw AppError.authentication("Session is no longer valid");
  }

  const valid = await verifyPassword(user.passwordHash, input.currentPassword);
  if (!valid) {
    throw AppError.authentication("Current password is incorrect");
  }

  await repo.updatePasswordHash(userId, await hashPassword(input.newPassword));
  const revoked = await repo.revokeAllSessions(userId, {
    exceptSessionId: currentSessionId,
  });

  await recordAuditEvent({
    ...context,
    actorId: userId,
    action: AuditAction.PASSWORD_CHANGED,
    targetType: "user",
    targetId: userId,
    metadata: { sessionsRevoked: revoked },
  });

  await emailService.sendSecurityAlertEmail(user.email, {
    displayName: user.displayName,
    event: "your password was changed",
  });
}

/* ── Sessions ───────────────────────────────────────────────────────────── */

export async function listSessions(
  userId: string,
  currentSessionId: string,
): Promise<SessionView[]> {
  const sessions = await repo.listActiveSessions(userId);

  return sessions.map((session) => ({
    id: session.id,
    userAgent: session.userAgent,
    ipAddress: session.ipAddress,
    createdAt: session.createdAt.toISOString(),
    lastUsedAt: session.lastUsedAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    current: session.id === currentSessionId,
  }));
}

/**
 * Revokes one session.
 *
 * The ownership check is server-side and non-negotiable (ARCHITECTURE §18):
 * a session id is a guessable-looking UUID in a URL, and without this any
 * authenticated user could sign out any other.
 */
export async function revokeSession(
  userId: string,
  sessionId: string,
  context: RequestContext,
): Promise<void> {
  const session = await repo.findSessionById(sessionId);

  // Same response for "not found" and "belongs to someone else" — otherwise
  // this endpoint tells a caller which session ids exist.
  if (!session || session.userId !== userId) {
    throw AppError.notFound("Session not found");
  }

  await repo.revokeSession(sessionId);

  await recordAuditEvent({
    ...context,
    actorId: userId,
    action: AuditAction.SESSION_REVOKED,
    targetType: "user",
    targetId: userId,
    metadata: { sessionId },
  });
}

export async function revokeOtherSessions(
  userId: string,
  currentSessionId: string,
  context: RequestContext,
): Promise<number> {
  const revoked = await repo.revokeAllSessions(userId, {
    exceptSessionId: currentSessionId,
  });

  await recordAuditEvent({
    ...context,
    actorId: userId,
    action: AuditAction.ALL_SESSIONS_REVOKED,
    targetType: "user",
    targetId: userId,
    metadata: { sessionsRevoked: revoked },
  });

  return revoked;
}

/* ── Two-factor authentication ──────────────────────────────────────────── */

/**
 * Starts enrollment. The secret is stored encrypted and returned exactly once
 * — this response is the only time it is ever readable, because the user has
 * to transfer it into an authenticator app.
 *
 * 2FA is not active until `confirmTwoFactor` proves the app was set up
 * correctly, so an abandoned enrollment cannot lock anyone out.
 */
export async function startTwoFactorEnrollment(
  userId: string,
  context: RequestContext,
): Promise<TwoFactorEnrollment> {
  const user = await repo.findProfileById(userId);
  if (!user) throw AppError.authentication("Session is no longer valid");

  const existing = await repo.findTwoFactor(userId);
  if (existing?.enabled === true) {
    throw AppError.conflict("Two-factor authentication is already enabled");
  }

  const secret = generateTotpSecret();
  await repo.upsertTwoFactorSecret({ userId, encryptedSecret: encryptSecret(secret) });

  await recordAuditEvent({
    ...context,
    actorId: userId,
    action: AuditAction.TWO_FACTOR_ENROLLMENT_STARTED,
    targetType: "user",
    targetId: userId,
  });

  return { secret, otpauthUrl: buildOtpauthUrl(secret, user.username) };
}

export interface TwoFactorConfirmResult {
  /** Plaintext recovery codes, shown once and never retrievable again. */
  backupCodes: string[];
}

export async function confirmTwoFactor(
  userId: string,
  code: string,
  context: RequestContext,
): Promise<TwoFactorConfirmResult> {
  const credential = await repo.findTwoFactor(userId);

  if (!credential) {
    throw AppError.validation("Start two-factor setup before confirming it");
  }
  if (credential.enabled) {
    throw AppError.conflict("Two-factor authentication is already enabled");
  }

  const valid = await verifyTotp(decryptSecret(credential.secret), code);

  if (!valid) {
    await recordAuditEvent({
      ...context,
      actorId: userId,
      action: AuditAction.TWO_FACTOR_CHALLENGE_FAILED,
      targetType: "user",
      targetId: userId,
      metadata: { stage: "enrollment" },
    });
    throw AppError.validation("That code is not valid. Try the current one.");
  }

  const backupCodes = generateBackupCodes();
  await repo.enableTwoFactor({
    userId,
    backupCodeHashes: backupCodes.map(hashBackupCode),
  });

  await recordAuditEvent({
    ...context,
    actorId: userId,
    action: AuditAction.TWO_FACTOR_ENABLED,
    targetType: "user",
    targetId: userId,
  });

  const user = await repo.findCredentialsById(userId);
  if (user) {
    await emailService.sendSecurityAlertEmail(user.email, {
      displayName: user.displayName,
      event: "two-factor authentication was enabled",
    });
  }

  return { backupCodes };
}

/**
 * Disabling requires the password again. A session alone is not enough:
 * an attacker with a borrowed unlocked browser must not be able to strip the
 * second factor and lock the owner out.
 */
export async function disableTwoFactor(
  userId: string,
  password: string,
  context: RequestContext,
): Promise<void> {
  const user = await repo.findCredentialsById(userId);

  if (!user?.passwordHash) {
    throw AppError.authentication("Session is no longer valid");
  }

  const valid = await verifyPassword(user.passwordHash, password);
  if (!valid) {
    throw AppError.authentication("Password is incorrect");
  }

  const credential = await repo.findTwoFactor(userId);
  if (!credential) {
    throw AppError.notFound("Two-factor authentication is not enabled");
  }

  await repo.deleteTwoFactor(userId);

  await recordAuditEvent({
    ...context,
    actorId: userId,
    action: AuditAction.TWO_FACTOR_DISABLED,
    targetType: "user",
    targetId: userId,
  });

  await emailService.sendSecurityAlertEmail(user.email, {
    displayName: user.displayName,
    event: "two-factor authentication was disabled",
  });
}

export interface TwoFactorChallengeInputs {
  challengeToken: string;
  code?: string | undefined;
  backupCode?: string | undefined;
}

/**
 * Completes a login that stopped at the 2FA step.
 *
 * Accepts either a TOTP code or a single-use backup code. Backup-code
 * redemption is conditional at the database level, so the same code cannot be
 * spent twice even by two simultaneous requests.
 */
export async function completeTwoFactorChallenge(
  inputs: TwoFactorChallengeInputs,
  context: RequestContext,
): Promise<LoginResult> {
  const payload = await readTwoFactorChallenge(inputs.challengeToken);

  if (!payload) {
    throw AppError.authentication("This verification session has expired");
  }

  await assertNotLockedOut("two-factor", payload.userId);

  const user = await repo.findCredentialsById(payload.userId);
  const credential = user ? await repo.findTwoFactor(user.id) : null;

  if (!user || !credential?.enabled) {
    await consumeTwoFactorChallenge(inputs.challengeToken);
    throw AppError.authentication("This verification session has expired");
  }

  const accepted = inputs.backupCode
    ? await redeemBackupCode(credential, inputs.backupCode, context)
    : await verifyTotp(decryptSecret(credential.secret), inputs.code ?? "");

  if (!accepted) {
    await recordFailedAttempt("two-factor", payload.userId);
    await recordAuditEvent({
      ...context,
      actorId: payload.userId,
      action: AuditAction.TWO_FACTOR_CHALLENGE_FAILED,
      targetType: "user",
      targetId: payload.userId,
      metadata: { stage: "login" },
    });
    throw AppError.authentication("That code is not valid");
  }

  await clearFailedAttempts("two-factor", payload.userId);
  await consumeTwoFactorChallenge(inputs.challengeToken);

  if ((await repo.liftExpiredSuspension(user.id, user.status)) === "banned") {
    throw AppError.authorization("This account has been suspended");
  }

  return finalizeLogin(user, context, payload.rememberMe);
}

async function redeemBackupCode(
  credential: { userId: string; backupCodes: string[] },
  submitted: string,
  context: RequestContext,
): Promise<boolean> {
  const digest = hashBackupCode(submitted);

  if (!credential.backupCodes.includes(digest)) return false;

  const remaining = credential.backupCodes.filter((stored) => stored !== digest);
  const consumed = await repo.consumeBackupCode(credential.userId, digest, remaining);

  if (!consumed) return false;

  await recordAuditEvent({
    ...context,
    actorId: credential.userId,
    action: AuditAction.TWO_FACTOR_BACKUP_CODE_USED,
    targetType: "user",
    targetId: credential.userId,
    metadata: { remaining: remaining.length },
  });

  return true;
}

export type { AuditContext };
