import type { ActivityItem, ContributionDay, FollowerPreview, User } from "@/types";
import { getMockContributionGraph } from "@/lib/mock/contributions";
import { mockFollowerPreviews } from "@/lib/mock/followers";
import { mockProfileTimelines } from "@/lib/mock/timeline";
import { mockUsersByUsername } from "@/lib/mock/users";

/** Placeholder for the Profile API (TRD.md §5). */

export async function getUserByUsername(username: string): Promise<User | null> {
  return mockUsersByUsername[username] ?? null;
}

export async function getContributionGraph(username: string): Promise<ContributionDay[]> {
  return getMockContributionGraph(username);
}

export async function getProfileTimeline(username: string): Promise<ActivityItem[]> {
  return mockProfileTimelines[username] ?? [];
}

/** Shared preview pool for every profile in this demo — see
 * docs/ASSUMPTIONS.md (Phase 05). */
export async function getFollowerPreviews(): Promise<FollowerPreview[]> {
  return mockFollowerPreviews;
}
