import type { AdminUserSummary } from "@/types";
import { AMAKA, DANA, LENA, RIKO, THEO } from "@/lib/mock/people";
import { mockCurrentUser } from "@/lib/mock/users";

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

const JULES = {
  id: "flw_005",
  username: "jules.f",
  displayName: "Jules Fontaine",
  avatarUrl: null,
  builderRank: "Newcomer",
};

/** `AdminUserSummary` fixtures (TRD.md §4 Users + §4.13 User Roles). Mixes
 * every `ModerationStatus` so the Users table has something to demonstrate
 * for each action — see docs/ASSUMPTIONS.md (Phase 11). */
export const mockAdminUsers: AdminUserSummary[] = [
  {
    user: mockCurrentUser,
    role: mockCurrentUser.role,
    status: "active",
    joinedAt: mockCurrentUser.createdAt,
    projectsCount: mockCurrentUser.projectsCount,
    followersCount: mockCurrentUser.followersCount,
  },
  {
    user: DANA,
    role: "verified_builder",
    status: "active",
    joinedAt: daysAgo(365),
    projectsCount: 3,
    followersCount: 4820,
  },
  {
    user: RIKO,
    role: "member",
    status: "active",
    joinedAt: daysAgo(210),
    projectsCount: 2,
    followersCount: 2140,
  },
  {
    user: AMAKA,
    role: "member",
    status: "active",
    joinedAt: daysAgo(150),
    projectsCount: 1,
    followersCount: 890,
  },
  {
    user: THEO,
    role: "member",
    status: "shadow_banned",
    joinedAt: daysAgo(120),
    projectsCount: 1,
    followersCount: 610,
  },
  {
    user: LENA,
    role: "member",
    status: "active",
    joinedAt: daysAgo(95),
    projectsCount: 1,
    followersCount: 480,
  },
  {
    user: JULES,
    role: "guest",
    status: "banned",
    joinedAt: daysAgo(30),
    projectsCount: 0,
    followersCount: 4,
  },
];
