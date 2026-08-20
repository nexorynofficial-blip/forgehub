import type { MessagePermission, ProfileVisibility, UserRole } from "@prisma/client";

/**
 * Contracts for the users module.
 *
 * `UserView` mirrors the shipped frontend's `User` type (`src/types/user.ts`)
 * field for field. That is not a coincidence to be tidied up later — the
 * finished profile page destructures exactly these keys, so the API has to
 * serve this shape or the UI breaks.
 */

export interface SocialLinkView {
  platform: string;
  url: string;
}

/** Matches the frontend's `Achievement` (`src/types/user.ts`). */
export interface AchievementView {
  id: string;
  name: string;
  description: string;
  iconUrl: string | null;
  unlockedAt: string | null;
}

/** Matches the frontend's `Badge`. */
export interface BadgeView {
  id: string;
  label: string;
  iconUrl: string | null;
}

/**
 * The full profile shape. Served only when the viewer is permitted to see it
 * — see `visibility.ts` for the rules.
 *
 * `email` is `string | null`: the frontend's `User.email` is a required
 * string, but a profile whose owner has not opted into `showEmailOnProfile`
 * must not carry a real address. Null is the honest value, and the shipped UI
 * never renders it on someone else's profile.
 */
export interface UserView {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  bio: string;
  skills: string[];
  techStack: string[];
  socialLinks: SocialLinkView[];
  experienceYears: number | null;
  achievements: AchievementView[];
  badges: BadgeView[];
  followersCount: number;
  followingCount: number;
  projectsCount: number;
  role: UserRole;

  /** PRD.md §4.10 Reputation. Read-only in Phase 4 — no endpoint mutates these. */
  xp: number;
  builderRank: string;
  dailyStreak: number;
  contributionScore: number;
  communityScore: number;

  createdAt: string;
}

/**
 * What a non-follower sees of a followers-only profile (decision J4).
 *
 * Identity only. No email, bio, skills, tech stack, social links, experience,
 * achievements, badges, or reputation detail — those are the private surface.
 * `builderRank` and the counters stay because they are aggregate labels the
 * profile header renders as a shell, not content the owner authored.
 *
 * `restricted: true` is what lets a client tell "you cannot see this yet"
 * apart from "this profile is genuinely empty".
 */
export interface RedactedUserView {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  role: UserRole;
  builderRank: string;
  followersCount: number;
  followingCount: number;
  projectsCount: number;
  createdAt: string;
  restricted: true;
}

export type ProfileResponse = UserView | RedactedUserView;

/**
 * The shared compact user projection. Mirrors the frontend's `PostAuthor`
 * (`src/types/feed.ts`), which admin, messaging, and communities all reuse —
 * defining it once here stops four later phases inventing four variants.
 */
export interface UserSummaryView {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  builderRank: string;
}

/** Mirrors the frontend's `FollowerPreview` (`src/types/profile.ts`). */
export interface UserPreviewView {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

/**
 * Viewer-relative relationship state, so the profile header can render the
 * follow button without a second round trip.
 *
 * There is deliberately no `isBlockedBy`. If the target has blocked the
 * viewer the profile resolves to 404, so a field announcing "you are blocked"
 * would be both redundant and a disclosure.
 */
export interface RelationshipView {
  isSelf: boolean;
  isFollowing: boolean;
  isFollowedBy: boolean;
  isBlocking: boolean;
}

/** Mirrors the frontend's `PrivacySettings` (`src/types/settings.ts`). */
export interface PrivacySettingsView {
  profileVisibility: ProfileVisibility;
  showEmailOnProfile: boolean;
  whoCanMessage: MessagePermission;
  /** Joined from `TwoFactorCredential`, which owns the flag (Phase 3). */
  twoFactorEnabled: boolean;
}

export interface NotificationChannelView {
  inApp: boolean;
  email: boolean;
}

/**
 * Mirrors the frontend's `NotificationPreferences`:
 * `Record<NotificationType, { inApp, email }>`.
 */
export type NotificationPreferencesView = Record<string, NotificationChannelView>;

/** `/users/me` — the caller's own record, plus owner-only fields. */
export interface CurrentUserView extends UserView {
  emailVerified: boolean;
  /** 0-100. Drives profile-completion prompts; never shown on other profiles. */
  profileCompletion: number;
  profileVisibility: ProfileVisibility;
}
