import type {
  LeaderboardEntry,
  RecentConversationPreview,
  TrendingProjectSummary,
  UpcomingEvent,
} from "@/types";
import { mockRecentConversations } from "@/lib/mock/conversations";
import { mockUpcomingEvents } from "@/lib/mock/events";
import { mockLeaderboard } from "@/lib/mock/leaderboard";
import { mockTrendingProjects } from "@/lib/mock/trending-projects";

/** Placeholder services for the dashboard (Phase 04). Real endpoints would
 * plausibly be the Project API (trending), a Reputation/Leaderboard
 * endpoint, the Community API (events), and the Messaging API (previews)
 * per TRD.md §5. */

export async function getTrendingProjects(): Promise<TrendingProjectSummary[]> {
  return mockTrendingProjects;
}

export async function getLeaderboard(): Promise<LeaderboardEntry[]> {
  return mockLeaderboard;
}

export async function getUpcomingEvents(): Promise<UpcomingEvent[]> {
  return mockUpcomingEvents;
}

export async function getRecentConversations(): Promise<RecentConversationPreview[]> {
  return mockRecentConversations;
}
