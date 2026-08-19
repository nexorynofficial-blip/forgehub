import type { ID, ISODateString, UserRole } from "./common";

/** PRD.md §4.2 User Profiles. TRD.md §4 models Users/Profiles as separate
 * entities; the frontend consumes them as one joined view — see
 * docs/ASSUMPTIONS.md. */
export interface SocialLink {
  platform: string;
  url: string;
}

export interface Achievement {
  id: ID;
  name: string;
  description: string;
  iconUrl: string | null;
  unlockedAt: ISODateString | null;
}

export interface Badge {
  id: ID;
  label: string;
  iconUrl: string | null;
}

export interface User {
  id: ID;
  username: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  bio: string;
  skills: string[];
  techStack: string[];
  socialLinks: SocialLink[];
  experienceYears: number | null;
  achievements: Achievement[];
  badges: Badge[];
  followersCount: number;
  followingCount: number;
  projectsCount: number;
  role: UserRole;

  /** PRD.md §4.10 Reputation System */
  xp: number;
  builderRank: string;
  dailyStreak: number;
  contributionScore: number;
  communityScore: number;

  createdAt: ISODateString;
}
