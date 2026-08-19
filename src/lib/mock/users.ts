import type { User } from "@/types";

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

/**
 * Fixture data standing in for the Profile/Users API (TRD.md §5) until the
 * backend exists. Every later phase that needs a user should add fixtures
 * here rather than inlining literals in components — see
 * src/lib/services/user-service.ts for the consuming pattern.
 */
export const mockCurrentUser: User = {
  id: "usr_forge_001",
  username: "ava.codes",
  displayName: "Ava Whitfield",
  email: "ava@forgehub.dev",
  avatarUrl: null,
  bannerUrl: null,
  bio: "Building ForgeHub in public. Full-stack engineer, ex-Stripe.",
  skills: ["TypeScript", "React", "Systems Design"],
  techStack: ["Next.js", "Node.js", "PostgreSQL"],
  socialLinks: [
    { platform: "github", url: "https://github.com" },
    { platform: "x", url: "https://x.com" },
  ],
  experienceYears: 6,
  achievements: [
    {
      id: "ach_001",
      name: "12-Day Streak",
      description: "Posted a build update 12 days in a row.",
      iconUrl: null,
      unlockedAt: daysAgo(0),
    },
    {
      id: "ach_002",
      name: "First Launch",
      description: "Shipped a project from idea to launched.",
      iconUrl: null,
      unlockedAt: daysAgo(48),
    },
    {
      id: "ach_003",
      name: "1K Followers",
      description: "Reached 1,000 followers on ForgeHub.",
      iconUrl: null,
      unlockedAt: daysAgo(15),
    },
    {
      id: "ach_004",
      name: "Community Pillar",
      description: "Answered 100 questions across ForgeHub communities.",
      iconUrl: null,
      unlockedAt: daysAgo(120),
    },
  ],
  badges: [
    { id: "bdg_001", label: "Verified Builder", iconUrl: null },
    { id: "bdg_002", label: "Early Adopter", iconUrl: null },
  ],
  followersCount: 1284,
  followingCount: 312,
  projectsCount: 4,
  role: "platform_admin",
  xp: 8420,
  builderRank: "Architect",
  dailyStreak: 12,
  contributionScore: 742,
  communityScore: 318,
  createdAt: "2025-02-14T09:00:00.000Z",
};

export const mockUserDana: User = {
  id: "usr_002",
  username: "dana.builds",
  displayName: "Dana Okafor",
  email: "dana@forgehub.dev",
  avatarUrl: null,
  bannerUrl: null,
  bio: "Founder of Tidal Notes. Offline-first everything. Previously eng lead at a11y-first startups.",
  skills: ["Product", "Rust", "Offline Sync"],
  techStack: ["Next.js", "SQLite", "CRDT"],
  socialLinks: [
    { platform: "github", url: "https://github.com" },
    { platform: "x", url: "https://x.com" },
  ],
  experienceYears: 9,
  achievements: [
    {
      id: "ach_101",
      name: "1K Users",
      description: "Reached 1,000 active users on a project.",
      iconUrl: null,
      unlockedAt: daysAgo(2),
    },
    {
      id: "ach_102",
      name: "Visionary",
      description: "Reached the top of the ForgeHub leaderboard.",
      iconUrl: null,
      unlockedAt: daysAgo(20),
    },
  ],
  badges: [{ id: "bdg_101", label: "Verified Builder", iconUrl: null }],
  followersCount: 4820,
  followingCount: 198,
  projectsCount: 3,
  role: "verified_builder",
  xp: 14820,
  builderRank: "Visionary",
  dailyStreak: 34,
  contributionScore: 1204,
  communityScore: 890,
  createdAt: "2024-08-02T09:00:00.000Z",
};

export const mockUserRiko: User = {
  id: "usr_003",
  username: "riko.tanaka",
  displayName: "Riko Tanaka",
  email: "riko@forgehub.dev",
  avatarUrl: null,
  bannerUrl: null,
  bio: "Indie hacker. Building small, sharp tools for other builders. Sprite editor nerd.",
  skills: ["Canvas", "Game Dev", "DX"],
  techStack: ["React", "Canvas", "WebSockets"],
  socialLinks: [{ platform: "github", url: "https://github.com" }],
  experienceYears: 5,
  achievements: [
    {
      id: "ach_201",
      name: "First Launch",
      description: "Shipped a project from idea to launched.",
      iconUrl: null,
      unlockedAt: daysAgo(78),
    },
  ],
  badges: [],
  followersCount: 2140,
  followingCount: 410,
  projectsCount: 2,
  role: "member",
  xp: 12940,
  builderRank: "Architect",
  dailyStreak: 6,
  contributionScore: 966,
  communityScore: 412,
  createdAt: "2025-01-10T09:00:00.000Z",
};

/** Lookup used by the Profile API mock — see src/lib/services/profile-service.ts. */
export const mockUsersByUsername: Record<string, User> = {
  [mockCurrentUser.username]: mockCurrentUser,
  [mockUserDana.username]: mockUserDana,
  [mockUserRiko.username]: mockUserRiko,
};
