import type {
  LeaderboardEntry,
  RecentConversationPreview,
  TrendingProjectSummary,
  UpcomingEvent,
} from "@/types";
import { getConversations, otherParticipant } from "@/lib/services/messaging-service";
import { getTrendingProjects as fetchTrendingProjects } from "@/lib/services/project-service";

/**
 * The authenticated dashboard's widgets.
 *
 * Two of the four are real. The other two have no endpoint behind them, and
 * this file says so rather than serving a fixture that looks like the signed-in
 * user's own data — which is exactly what a dashboard implies.
 */

/**
 * `GET /projects/trending`.
 *
 * Delegates to the projects service rather than re-issuing the request here:
 * two call paths to one endpoint is how response shapes drift apart.
 */
export async function getTrendingProjects(): Promise<TrendingProjectSummary[]> {
  return fetchTrendingProjects();
}

/**
 * The recent-conversations widget, composed from the real conversation list.
 *
 * Not a separate endpoint — `GET /messages/conversations` already returns the
 * most recently active threads first, with `lastMessage` and `unreadCount`
 * embedded, so the widget is a projection of its first page rather than a
 * second API. `isOnline` is deliberately `false` here: presence arrives over
 * the socket, and a service function has no subscription to read it from. The
 * widget applies live presence itself.
 */
export async function getRecentConversations(
  limit = 4,
): Promise<RecentConversationPreview[]> {
  const page = await getConversations({ limit });

  return page.items.map((conversation) => {
    const person = otherParticipant(conversation);
    return {
      id: conversation.id,
      participantId: person?.id ?? null,
      participantName: person?.displayName ?? conversation.title ?? "Conversation",
      participantAvatarUrl: person?.avatarUrl ?? null,
      lastMessage: conversation.lastMessage?.content ?? "",
      lastMessageAt:
        conversation.lastMessage?.createdAt ??
        conversation.lastMessageAt ??
        conversation.createdAt,
      unreadCount: conversation.unreadCount,
      isOnline: false,
    };
  });
}

/**
 * **Unavailable — no backend endpoint exists.**
 *
 * There is no leaderboard, ranking, or XP-ordering route anywhere in the
 * backend's 133 operations, and the `xp` a leaderboard would sort by is not
 * served by any list endpoint either. Computing one client-side would mean
 * paging every user in the platform and inventing the ranking rule.
 *
 * Returns empty rather than a fixture: a podium of fabricated names on a
 * signed-in dashboard reads as a real ranking of real people.
 */
export async function getLeaderboard(): Promise<LeaderboardEntry[]> {
  return [];
}

/**
 * **Unavailable — no backend endpoint exists.**
 *
 * Events are per-community (`GET /communities/{slug}/events`); there is no
 * global upcoming-events route. The alternative would be fanning out across
 * every community the user belongs to — an unbounded number of requests to
 * simulate a missing API — so the widget renders an unavailable state instead.
 */
export async function getUpcomingEvents(): Promise<UpcomingEvent[]> {
  return [];
}
