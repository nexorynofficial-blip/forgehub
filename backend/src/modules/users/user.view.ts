import type { UserProfileRow, UserSummaryRow } from "./users.repository.js";
import type {
  AchievementView,
  BadgeView,
  CurrentUserView,
  RedactedUserView,
  UserPreviewView,
  UserSummaryView,
  UserView,
} from "./users.types.js";

/**
 * The projection layer.
 *
 * Nothing outside this file turns a Prisma row into an API response. That is
 * the whole point: a single chokepoint means "does this endpoint leak
 * `passwordHash`?" has one place to check rather than one per controller.
 *
 * The repository's selects already exclude credential columns, so this is
 * defence in depth — but the layer that decides *shape* and the layer that
 * decides *exposure* are the same layer, which is what keeps the email rule
 * from drifting away from the visibility rule.
 */

function toAchievements(row: UserProfileRow): AchievementView[] {
  return row.achievements.map((entry) => ({
    id: entry.achievement.id,
    name: entry.achievement.name,
    description: entry.achievement.description,
    iconUrl: entry.achievement.iconUrl,
    unlockedAt: entry.unlockedAt.toISOString(),
  }));
}

function toBadges(row: UserProfileRow): BadgeView[] {
  return row.badges.map((entry) => ({
    id: entry.badge.id,
    label: entry.badge.label,
    iconUrl: entry.badge.iconUrl,
  }));
}

/**
 * The full profile.
 *
 * `includeEmail` is a required parameter rather than an option with a default
 * — a caller must make the privacy decision explicitly, and forgetting to
 * pass it is a compile error rather than a silent disclosure.
 */
export function toUserView(row: UserProfileRow, includeEmail: boolean): UserView {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    email: includeEmail ? row.email : null,
    avatarUrl: row.profile?.avatarUrl ?? null,
    bannerUrl: row.profile?.bannerUrl ?? null,
    bio: row.profile?.bio ?? "",
    skills: row.profile?.skills ?? [],
    techStack: row.profile?.techStack ?? [],
    socialLinks:
      row.profile?.socialLinks.map((link) => ({
        platform: link.platform,
        url: link.url,
      })) ?? [],
    experienceYears: row.profile?.experienceYears ?? null,
    achievements: toAchievements(row),
    badges: toBadges(row),
    followersCount: row.followersCount,
    followingCount: row.followingCount,
    projectsCount: row.projectsCount,
    role: row.role,
    xp: row.xp,
    builderRank: row.builderRank,
    dailyStreak: row.dailyStreak,
    contributionScore: row.contributionScore,
    communityScore: row.communityScore,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Identity-only shell for a followers-only profile seen by a non-follower.
 *
 * Built by *construction*, never by deleting keys from a full view — an
 * omission list would silently start leaking the day a new field is added to
 * `UserView`. Adding a field here has to be a deliberate act.
 */
export function toRedactedUserView(row: UserProfileRow): RedactedUserView {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: row.profile?.avatarUrl ?? null,
    bannerUrl: row.profile?.bannerUrl ?? null,
    role: row.role,
    builderRank: row.builderRank,
    followersCount: row.followersCount,
    followingCount: row.followingCount,
    projectsCount: row.projectsCount,
    createdAt: row.createdAt.toISOString(),
    restricted: true,
  };
}

/** `/users/me`. The caller always sees their own email and completion score. */
export function toCurrentUserView(row: UserProfileRow): CurrentUserView {
  return {
    ...toUserView(row, true),
    emailVerified: row.emailVerified,
    profileCompletion: row.profile?.completionPercent ?? 0,
    profileVisibility: row.profile?.visibility ?? "public",
  };
}

/** Mirrors the frontend's `PostAuthor`. */
export function toUserSummary(row: UserSummaryRow): UserSummaryView {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: row.profile?.avatarUrl ?? null,
    builderRank: row.builderRank,
  };
}

/** Mirrors the frontend's `FollowerPreview` — no `builderRank`. */
export function toUserPreview(row: UserSummaryRow): UserPreviewView {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: row.profile?.avatarUrl ?? null,
  };
}

/* ── Profile completion ─────────────────────────────────────────────────── */

/**
 * Nine equally weighted signals of a filled-in profile.
 *
 * Equal weighting is a deliberate simplification: any ranking would be an
 * invented product opinion, and the number exists to nudge users toward the
 * empty fields, not to be precise. The column is cached on `Profile` so the
 * dashboard can render a completion prompt without recomputing per request.
 */
export interface ProfileCompletionInput {
  avatarUrl: string | null;
  bannerUrl: string | null;
  bio: string;
  location: string | null;
  websiteUrl: string | null;
  skills: string[];
  techStack: string[];
  experienceYears: number | null;
  socialLinksCount: number;
}

export function calculateProfileCompletion(input: ProfileCompletionInput): number {
  const signals = [
    input.avatarUrl !== null && input.avatarUrl.length > 0,
    input.bannerUrl !== null && input.bannerUrl.length > 0,
    input.bio.trim().length > 0,
    input.location !== null && input.location.trim().length > 0,
    input.websiteUrl !== null && input.websiteUrl.length > 0,
    input.skills.length > 0,
    input.techStack.length > 0,
    input.experienceYears !== null,
    input.socialLinksCount > 0,
  ];

  const met = signals.filter(Boolean).length;
  return Math.round((met / signals.length) * 100);
}

/** Convenience wrapper for computing directly from a loaded row. */
export function completionFromRow(row: UserProfileRow): number {
  return calculateProfileCompletion({
    avatarUrl: row.profile?.avatarUrl ?? null,
    bannerUrl: row.profile?.bannerUrl ?? null,
    bio: row.profile?.bio ?? "",
    location: row.profile?.location ?? null,
    websiteUrl: row.profile?.websiteUrl ?? null,
    skills: row.profile?.skills ?? [],
    techStack: row.profile?.techStack ?? [],
    experienceYears: row.profile?.experienceYears ?? null,
    socialLinksCount: row.profile?.socialLinks.length ?? 0,
  });
}
