import {
  NotificationType,
  type EmailVerificationToken,
  type ModerationStatus,
  type PasswordResetToken,
  type Prisma,
  type RefreshToken,
  type Session,
  type TwoFactorCredential,
  type UserRole,
} from "@prisma/client";

import { prisma } from "../../database/prisma.js";

/**
 * The only layer that touches Prisma for authentication
 * (BACKEND_ARCHITECTURE.md §4). Services call these; controllers never do.
 *
 * Every read filters `deletedAt: null`. Account closure is a soft delete
 * (see `docs/DATABASE.md`), so a query that forgets this would happily
 * authenticate a closed account.
 */

/** Narrow projection for `req.user` — never selects `passwordHash`. */
const identitySelect = {
  id: true,
  email: true,
  username: true,
  displayName: true,
  role: true,
  status: true,
  emailVerified: true,
} satisfies Prisma.UserSelect;

export type UserIdentity = Prisma.UserGetPayload<{ select: typeof identitySelect }>;

/** Projection backing `AuthUserView`. Joins the profile for avatar/bio. */
const profileSelect = {
  ...identitySelect,
  createdAt: true,
  profile: { select: { avatarUrl: true, bannerUrl: true, bio: true } },
  twoFactor: { select: { enabled: true } },
} satisfies Prisma.UserSelect;

export type UserWithProfile = Prisma.UserGetPayload<{ select: typeof profileSelect }>;

/** Credential projection — the only place `passwordHash` is ever read. */
const credentialsSelect = {
  ...profileSelect,
  passwordHash: true,
} satisfies Prisma.UserSelect;

export type UserCredentials = Prisma.UserGetPayload<{ select: typeof credentialsSelect }>;

/* ── Users ──────────────────────────────────────────────────────────────── */

export async function findIdentityById(id: string): Promise<UserIdentity | null> {
  return prisma.user.findFirst({
    where: { id, deletedAt: null },
    select: identitySelect,
  });
}

export async function findProfileById(id: string): Promise<UserWithProfile | null> {
  return prisma.user.findFirst({ where: { id, deletedAt: null }, select: profileSelect });
}

export async function findCredentialsByEmail(
  email: string,
): Promise<UserCredentials | null> {
  return prisma.user.findFirst({
    where: { email, deletedAt: null },
    select: credentialsSelect,
  });
}

export async function findCredentialsById(id: string): Promise<UserCredentials | null> {
  return prisma.user.findFirst({
    where: { id, deletedAt: null },
    select: credentialsSelect,
  });
}

export async function emailExists(email: string): Promise<boolean> {
  const match = await prisma.user.findFirst({
    where: { email, deletedAt: null },
    select: { id: true },
  });
  return match !== null;
}

/**
 * Usernames already claimed under a prefix, used to pick the next free
 * numeric suffix. Soft-deleted rows are included on purpose: the column is
 * uniquely indexed regardless of `deletedAt`, so a closed account still
 * occupies its handle.
 */
export async function findUsernamesStartingWith(prefix: string): Promise<string[]> {
  const rows = await prisma.user.findMany({
    where: { username: { startsWith: prefix } },
    select: { username: true },
  });
  return rows.map((row) => row.username);
}

export interface CreateUserInput {
  email: string;
  username: string;
  displayName: string;
  passwordHash: string;
}

/**
 * Creates the user together with the rows every account is expected to have.
 *
 * One transaction, because a user without settings or notification
 * preferences is a broken state that later phases would have to defend
 * against on every read. Throws Prisma `P2002` if the email or username is
 * taken — the service turns that into a conflict or a username retry.
 */
export async function createUser(input: CreateUserInput): Promise<UserWithProfile> {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: input.email,
        username: input.username,
        displayName: input.displayName,
        passwordHash: input.passwordHash,
        // `guest` is a frontend-only sentinel for "not signed in" and must
        // never be persisted; every real account starts as `member`.
        role: "member",
        profile: { create: {} },
        settings: { create: {} },
        notificationPrefs: {
          create: Object.values(NotificationType).map((type) => ({ type })),
        },
      },
      select: profileSelect,
    });

    return user;
  });
}

export async function markEmailVerified(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { emailVerified: true, emailVerifiedAt: new Date() },
  });
}

export async function updatePasswordHash(
  userId: string,
  passwordHash: string,
): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
}

export async function touchLastActive(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { lastActiveAt: new Date() },
  });
}

/* ── Sessions ───────────────────────────────────────────────────────────── */

export interface CreateSessionInput {
  userId: string;
  userAgent: string | null;
  ipAddress: string | null;
  expiresAt: Date;
}

export async function createSession(input: CreateSessionInput): Promise<Session> {
  return prisma.session.create({ data: input });
}

export async function findActiveSessionById(id: string): Promise<Session | null> {
  return prisma.session.findFirst({
    where: { id, revokedAt: null, expiresAt: { gt: new Date() } },
  });
}

/**
 * One round trip for the whole authentication check: is the session still
 * live, and who does it belong to?
 *
 * Doing this on every authenticated request is deliberate. It costs a query,
 * but it is what makes logout and "sign out everywhere" take effect
 * immediately instead of lingering until the 15-minute access token expires —
 * and it re-reads `status`, so a ban applies to the banned user's next
 * request rather than their next login.
 */
export async function findActiveSessionWithUser(
  sessionId: string,
  userId: string,
): Promise<{ session: Session; user: UserIdentity } | null> {
  const session = await prisma.session.findFirst({
    where: {
      id: sessionId,
      userId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
      user: { deletedAt: null },
    },
    include: { user: { select: identitySelect } },
  });

  if (!session) return null;

  const { user, ...rest } = session;
  return { session: rest, user };
}

export async function listActiveSessions(userId: string): Promise<Session[]> {
  return prisma.session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: "desc" },
  });
}

export async function findSessionById(id: string): Promise<Session | null> {
  return prisma.session.findUnique({ where: { id } });
}

export async function touchSession(id: string): Promise<void> {
  await prisma.session.update({ where: { id }, data: { lastUsedAt: new Date() } });
}

/**
 * Revokes a session and every refresh token hanging off it, in one
 * transaction — a revoked session whose tokens survived would still be usable.
 */
export async function revokeSession(id: string): Promise<void> {
  const now = new Date();
  await prisma.$transaction([
    prisma.session.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: now },
    }),
    prisma.refreshToken.updateMany({
      where: { sessionId: id, revokedAt: null },
      data: { revokedAt: now },
    }),
  ]);
}

/** Used on password change/reset and "sign out everywhere". */
export async function revokeAllSessions(
  userId: string,
  options: { exceptSessionId?: string } = {},
): Promise<number> {
  const now = new Date();
  const where: Prisma.SessionWhereInput = {
    userId,
    revokedAt: null,
    ...(options.exceptSessionId !== undefined
      ? { id: { not: options.exceptSessionId } }
      : {}),
  };

  const sessions = await prisma.session.findMany({ where, select: { id: true } });
  const ids = sessions.map((session) => session.id);
  if (ids.length === 0) return 0;

  await prisma.$transaction([
    prisma.session.updateMany({ where: { id: { in: ids } }, data: { revokedAt: now } }),
    prisma.refreshToken.updateMany({
      where: { sessionId: { in: ids }, revokedAt: null },
      data: { revokedAt: now },
    }),
  ]);

  return ids.length;
}

/* ── Refresh tokens ─────────────────────────────────────────────────────── */

export async function createRefreshToken(input: {
  sessionId: string;
  tokenHash: string;
  expiresAt: Date;
}): Promise<RefreshToken> {
  return prisma.refreshToken.create({ data: input });
}

/**
 * Looks up by hash *without* filtering on `revokedAt` — the caller must be
 * able to see an already-revoked token, because presenting one is the signal
 * that a stolen token is being replayed (see the service's reuse detection).
 */
export async function findRefreshTokenByHash(
  tokenHash: string,
): Promise<(RefreshToken & { session: Session }) | null> {
  return prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { session: true },
  });
}

/** Atomically retires the old token and links it to its replacement. */
export async function rotateRefreshToken(input: {
  currentTokenId: string;
  sessionId: string;
  nextTokenHash: string;
  expiresAt: Date;
}): Promise<RefreshToken> {
  const [, next] = await prisma.$transaction([
    prisma.refreshToken.update({
      where: { id: input.currentTokenId },
      data: { revokedAt: new Date() },
    }),
    prisma.refreshToken.create({
      data: {
        sessionId: input.sessionId,
        tokenHash: input.nextTokenHash,
        expiresAt: input.expiresAt,
      },
    }),
  ]);

  await prisma.refreshToken.update({
    where: { id: input.currentTokenId },
    data: { replacedByTokenId: next.id },
  });

  return next;
}

/* ── Email verification tokens ──────────────────────────────────────────── */

export async function createEmailVerificationToken(input: {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}): Promise<EmailVerificationToken> {
  return prisma.emailVerificationToken.create({ data: input });
}

export async function findEmailVerificationToken(
  tokenHash: string,
): Promise<EmailVerificationToken | null> {
  return prisma.emailVerificationToken.findUnique({ where: { tokenHash } });
}

/**
 * Marks the token used only if it is still unused, and reports whether that
 * actually happened. `updateMany` + count makes single-use enforcement atomic:
 * two concurrent requests cannot both observe `usedAt === null` and proceed.
 */
export async function consumeEmailVerificationToken(id: string): Promise<boolean> {
  const result = await prisma.emailVerificationToken.updateMany({
    where: { id, usedAt: null },
    data: { usedAt: new Date() },
  });
  return result.count === 1;
}

/** Invalidates outstanding verification links when a new one is issued. */
export async function invalidateEmailVerificationTokens(userId: string): Promise<void> {
  await prisma.emailVerificationToken.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: new Date() },
  });
}

/* ── Password reset tokens ──────────────────────────────────────────────── */

export async function createPasswordResetToken(input: {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}): Promise<PasswordResetToken> {
  return prisma.passwordResetToken.create({ data: input });
}

export async function findPasswordResetToken(
  tokenHash: string,
): Promise<PasswordResetToken | null> {
  return prisma.passwordResetToken.findUnique({ where: { tokenHash } });
}

export async function consumePasswordResetToken(id: string): Promise<boolean> {
  const result = await prisma.passwordResetToken.updateMany({
    where: { id, usedAt: null },
    data: { usedAt: new Date() },
  });
  return result.count === 1;
}

export async function invalidatePasswordResetTokens(userId: string): Promise<void> {
  await prisma.passwordResetToken.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: new Date() },
  });
}

/* ── Two-factor credentials ─────────────────────────────────────────────── */

export async function findTwoFactor(userId: string): Promise<TwoFactorCredential | null> {
  return prisma.twoFactorCredential.findUnique({ where: { userId } });
}

/** Enrollment is upsert-shaped so restarting setup replaces the old secret. */
export async function upsertTwoFactorSecret(input: {
  userId: string;
  encryptedSecret: string;
}): Promise<TwoFactorCredential> {
  return prisma.twoFactorCredential.upsert({
    where: { userId: input.userId },
    create: { userId: input.userId, secret: input.encryptedSecret, enabled: false },
    update: {
      secret: input.encryptedSecret,
      enabled: false,
      confirmedAt: null,
      backupCodes: [],
    },
  });
}

export async function enableTwoFactor(input: {
  userId: string;
  backupCodeHashes: string[];
}): Promise<void> {
  await prisma.twoFactorCredential.update({
    where: { userId: input.userId },
    data: {
      enabled: true,
      confirmedAt: new Date(),
      backupCodes: input.backupCodeHashes,
    },
  });
}

export async function deleteTwoFactor(userId: string): Promise<void> {
  await prisma.twoFactorCredential.delete({ where: { userId } });
}

/**
 * Removes a single backup-code hash, returning whether it was present.
 *
 * The conditional `updateMany` is what makes a code single-use under
 * concurrency: the write only lands while the hash is still in the array, so
 * two simultaneous redemptions cannot both succeed.
 */
export async function consumeBackupCode(
  userId: string,
  codeHash: string,
  remaining: string[],
): Promise<boolean> {
  const result = await prisma.twoFactorCredential.updateMany({
    where: { userId, backupCodes: { has: codeHash } },
    data: { backupCodes: remaining },
  });
  return result.count === 1;
}

/* ── Lazy suspension expiry (Phase 11, ruling R12) ───────────────────────── */

/**
 * Lifts a temporary suspension that has run out, and reports the account's
 * effective status.
 *
 * ARCHITECTURE §25 lists "Temporary suspension" and "Permanent ban" as
 * distinct moderation actions, and the schema draws the distinction on
 * `ModerationAction.expiresAt` — documented there as *"Set for temporary
 * suspensions; null means permanent."* Both leave `User.status` at `banned`,
 * because `ModerationStatus` has no fourth member. So the pair
 * `(status = banned, newest action = suspension with a past expiry)` is a
 * suspension that is over, and this is where it ends.
 *
 * **Lazily, with no scheduler.** Ruling R12 forbids a worker, a queue, or a
 * background process, and none is needed: a suspension only matters when the
 * suspended person tries to do something, so the check belongs on the path
 * they take when they try. The cost is one indexed query — on
 * `moderation_actions(targetUserId, createdAt DESC)` — and it is paid only by
 * accounts that are actually banned, which is the rare case.
 *
 * The *newest* status-affecting action decides. A user who was suspended and
 * then banned outright stays banned: the ban is newer, carries no expiry, and
 * this returns without touching the row. A user whose newest such action is a
 * lapsed suspension is restored to `active`.
 *
 * The restore and its audit row commit together. There is no moderator behind
 * this, so `actorId` is null — the trail records that the system lifted it,
 * which is the truth.
 *
 * Lives in the auth repository rather than the moderation module on purpose.
 * Auth is Phase 3 and moderation is Phase 11; importing the later module into
 * the earlier one would point the dependency arrow backwards. Reading a
 * `moderation_actions` row here is data-level coupling only, and it keeps the
 * call sites that need it — the middleware, the login paths, and the socket
 * handshake — reaching for something already in their own module.
 */
export async function liftExpiredSuspension(
  userId: string,
  status: ModerationStatus,
): Promise<ModerationStatus> {
  if (status !== "banned") return status;

  const latest = await prisma.moderationAction.findFirst({
    where: {
      targetUserId: userId,
      action: { in: ["suspension", "ban", "unban", "reinstate", "shadow_ban"] },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { action: true, expiresAt: true },
  });

  if (latest === null) return status;
  if (latest.action !== "suspension") return status;
  if (latest.expiresAt === null) return status;
  if (latest.expiresAt.getTime() > Date.now()) return status;

  const expiredAt = latest.expiresAt.toISOString();

  return prisma.$transaction(async (tx) => {
    // Guarded on the status still being `banned`, so a moderator re-banning
    // the account in the same instant is not silently undone by this.
    const lifted = await tx.user.updateMany({
      where: { id: userId, status: "banned" },
      data: { status: "active" },
    });

    if (lifted.count === 0) return status;

    await tx.auditLog.create({
      data: {
        actorId: null,
        action: "USER_SUSPENSION_EXPIRED",
        targetType: "user",
        targetId: userId,
        metadata: { expiredAt },
        ipAddress: null,
        userAgent: null,
      },
    });

    return "active";
  });
}

export type { ModerationStatus, UserRole };
