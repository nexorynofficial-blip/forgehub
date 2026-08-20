import {
  NotificationType,
  type MessagePermission,
  type Prisma,
  type ProfileVisibility,
} from "@prisma/client";

import { prisma } from "../../database/prisma.js";

/**
 * The only layer that touches Prisma for users and profiles
 * (BACKEND_ARCHITECTURE.md §4).
 *
 * Every read filters `deletedAt: null`. Account closure is a soft delete, so
 * a query that forgets it would resurrect a closed account's profile.
 *
 * Note what the selects below never include: `passwordHash`. The column is
 * reachable only from `auth.repository.ts`, which is the one place that has a
 * reason to read it.
 */

/** Full profile payload. `email` is selected; the *view* decides exposure. */
const profileSelect = {
  id: true,
  username: true,
  displayName: true,
  email: true,
  role: true,
  status: true,
  emailVerified: true,
  createdAt: true,
  xp: true,
  builderRank: true,
  dailyStreak: true,
  contributionScore: true,
  communityScore: true,
  followersCount: true,
  followingCount: true,
  projectsCount: true,
  profile: {
    select: {
      avatarUrl: true,
      bannerUrl: true,
      bio: true,
      location: true,
      websiteUrl: true,
      skills: true,
      techStack: true,
      experienceYears: true,
      visibility: true,
      completionPercent: true,
      socialLinks: {
        select: { platform: true, url: true },
        orderBy: { platform: "asc" },
      },
    },
  },
  /** Needed by the view to decide whether `email` may be exposed. */
  settings: { select: { showEmailOnProfile: true } },
  achievements: {
    select: {
      unlockedAt: true,
      achievement: {
        select: { id: true, name: true, description: true, iconUrl: true },
      },
    },
    orderBy: { unlockedAt: "desc" },
  },
  badges: {
    select: { badge: { select: { id: true, label: true, iconUrl: true } } },
    orderBy: { awardedAt: "desc" },
  },
} satisfies Prisma.UserSelect;

export type UserProfileRow = Prisma.UserGetPayload<{ select: typeof profileSelect }>;

/** Compact projection backing `UserSummaryView` / `UserPreviewView`. */
const summarySelect = {
  id: true,
  username: true,
  displayName: true,
  builderRank: true,
  profile: { select: { avatarUrl: true } },
} satisfies Prisma.UserSelect;

export type UserSummaryRow = Prisma.UserGetPayload<{ select: typeof summarySelect }>;

/* ── Reads ──────────────────────────────────────────────────────────────── */

export async function findByUsername(username: string): Promise<UserProfileRow | null> {
  return prisma.user.findFirst({
    // Usernames are stored lowercase, but a URL may arrive in any case.
    where: { username: username.toLowerCase(), deletedAt: null },
    select: profileSelect,
  });
}

export async function findById(id: string): Promise<UserProfileRow | null> {
  return prisma.user.findFirst({ where: { id, deletedAt: null }, select: profileSelect });
}

export async function usernameTaken(
  username: string,
  excludeUserId: string,
): Promise<boolean> {
  const match = await prisma.user.findFirst({
    // No `deletedAt` filter: the unique index covers soft-deleted rows too, so
    // a closed account still occupies its handle.
    where: { username: username.toLowerCase(), id: { not: excludeUserId } },
    select: { id: true },
  });
  return match !== null;
}

/* ── Profile updates ────────────────────────────────────────────────────── */

export interface ProfileUpdateInput {
  displayName?: string;
  bio?: string;
  location?: string | null;
  websiteUrl?: string | null;
  skills?: string[];
  techStack?: string[];
  experienceYears?: number | null;
  /** Replace-set semantics — see `replaceSocialLinks`. */
  socialLinks?: { platform: string; url: string }[];
}

/**
 * Applies a profile patch in one transaction.
 *
 * Social links are a **replace set**, not a merge: the Settings form submits
 * the complete list it knows about, so a merge would make removing a link
 * impossible. `deleteMany` + `createMany` inside the transaction keeps the
 * `@@unique([profileId, platform])` constraint satisfiable even when a
 * platform moves position.
 */
export async function updateProfile(
  userId: string,
  input: ProfileUpdateInput,
  completionPercent: number,
): Promise<UserProfileRow> {
  return prisma.$transaction(async (tx) => {
    if (input.displayName !== undefined) {
      await tx.user.update({
        where: { id: userId },
        data: { displayName: input.displayName },
      });
    }

    const profileData: Prisma.ProfileUpdateInput = { completionPercent };
    if (input.bio !== undefined) profileData.bio = input.bio;
    if (input.location !== undefined) profileData.location = input.location;
    if (input.websiteUrl !== undefined) profileData.websiteUrl = input.websiteUrl;
    if (input.skills !== undefined) profileData.skills = input.skills;
    if (input.techStack !== undefined) profileData.techStack = input.techStack;
    if (input.experienceYears !== undefined) {
      profileData.experienceYears = input.experienceYears;
    }

    const profile = await tx.profile.update({
      where: { userId },
      data: profileData,
      select: { id: true },
    });

    if (input.socialLinks !== undefined) {
      await tx.socialLink.deleteMany({ where: { profileId: profile.id } });
      if (input.socialLinks.length > 0) {
        await tx.socialLink.createMany({
          data: input.socialLinks.map((link) => ({
            profileId: profile.id,
            platform: link.platform,
            url: link.url,
          })),
        });
      }
    }

    const updated = await tx.user.findFirstOrThrow({
      where: { id: userId },
      select: profileSelect,
    });
    return updated;
  });
}

/** Throws Prisma `P2002` when the handle was claimed between check and write. */
export async function updateUsername(userId: string, username: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { username: username.toLowerCase() },
  });
}

export async function updateProfileCompletion(
  userId: string,
  completionPercent: number,
): Promise<void> {
  await prisma.profile.update({ where: { userId }, data: { completionPercent } });
}

/* ── Settings ───────────────────────────────────────────────────────────── */

export interface SettingsRow {
  showEmailOnProfile: boolean;
  whoCanMessage: MessagePermission;
  profileVisibility: ProfileVisibility;
  twoFactorEnabled: boolean;
}

/**
 * Privacy settings span three tables: `UserSettings` (contact preferences),
 * `Profile` (visibility), and `TwoFactorCredential` (the 2FA flag, which
 * Phase 3 deliberately kept as the single source of truth rather than
 * duplicating onto settings).
 */
export async function findSettings(userId: string): Promise<SettingsRow | null> {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: {
      settings: { select: { showEmailOnProfile: true, whoCanMessage: true } },
      profile: { select: { visibility: true } },
      twoFactor: { select: { enabled: true } },
    },
  });

  if (!user) return null;

  return {
    showEmailOnProfile: user.settings?.showEmailOnProfile ?? false,
    whoCanMessage: user.settings?.whoCanMessage ?? "everyone",
    profileVisibility: user.profile?.visibility ?? "public",
    twoFactorEnabled: user.twoFactor?.enabled ?? false,
  };
}

/** `| undefined` is explicit for `exactOptionalPropertyTypes`. */
export interface SettingsUpdateInput {
  showEmailOnProfile?: boolean | undefined;
  whoCanMessage?: MessagePermission | undefined;
  profileVisibility?: ProfileVisibility | undefined;
}

/**
 * `twoFactorEnabled` is intentionally not writable here — toggling 2FA goes
 * through the Phase 3 enrollment flow, which requires a verified TOTP code.
 * Accepting it as a settings field would let a client enable 2FA without ever
 * proving they hold the authenticator.
 */
export async function updateSettings(
  userId: string,
  input: SettingsUpdateInput,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const settingsData: Prisma.UserSettingsUpdateInput = {};
    if (input.showEmailOnProfile !== undefined) {
      settingsData.showEmailOnProfile = input.showEmailOnProfile;
    }
    if (input.whoCanMessage !== undefined) {
      settingsData.whoCanMessage = input.whoCanMessage;
    }

    if (Object.keys(settingsData).length > 0) {
      await tx.userSettings.update({ where: { userId }, data: settingsData });
    }

    if (input.profileVisibility !== undefined) {
      await tx.profile.update({
        where: { userId },
        data: { visibility: input.profileVisibility },
      });
    }
  });
}

/* ── Notification preferences ───────────────────────────────────────────── */

export interface NotificationPreferenceRow {
  type: NotificationType;
  inApp: boolean;
  email: boolean;
}

export async function findNotificationPreferences(
  userId: string,
): Promise<NotificationPreferenceRow[]> {
  return prisma.notificationPreference.findMany({
    where: { userId },
    select: { type: true, inApp: true, email: true },
    orderBy: { type: "asc" },
  });
}

/**
 * Upsert rather than update: registration seeds a row per type, but a type
 * added to the enum later would have no row for existing users, and the
 * Settings matrix must still be able to set it.
 */
export async function upsertNotificationPreference(
  userId: string,
  type: NotificationType,
  patch: { inApp?: boolean; email?: boolean },
): Promise<void> {
  await prisma.notificationPreference.upsert({
    where: { userId_type: { userId, type } },
    create: {
      userId,
      type,
      inApp: patch.inApp ?? true,
      email: patch.email ?? false,
    },
    update: {
      ...(patch.inApp !== undefined ? { inApp: patch.inApp } : {}),
      ...(patch.email !== undefined ? { email: patch.email } : {}),
    },
  });
}

/** Every enum value, so the API can return a complete matrix. */
export function allNotificationTypes(): NotificationType[] {
  return Object.values(NotificationType);
}

export { profileSelect, summarySelect };
