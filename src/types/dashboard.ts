import type { ID, ISODateString } from "./common";
import type { Notification } from "./notification";

/**
 * Presentation-layer types for the authenticated dashboard, same convention
 * as src/types/marketing.ts — shaped for what a widget renders, not a 1:1
 * TRD.md §4 entity. See docs/ASSUMPTIONS.md (Phase 04).
 */

export interface TrendingProjectSummary {
  id: ID;
  slug: string;
  title: string;
  description: string;
  coverImageUrl: string | null;
  techStack: string[];
  ownerName: string;
  ownerAvatarUrl: string | null;
  likesCount: number;
  progressPercent: number;
}

export interface LeaderboardEntry {
  rank: number;
  userId: ID;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  builderRank: string;
  xp: number;
}

export interface UpcomingEvent {
  id: ID;
  title: string;
  communityName: string;
  startsAt: ISODateString;
  isOnline: boolean;
  attendeeCount: number;
}

export interface RecentConversationPreview {
  id: ID;
  /** Null for a group thread, which has no single counterpart. */
  participantId: ID | null;
  participantName: string;
  participantAvatarUrl: string | null;
  lastMessage: string;
  lastMessageAt: ISODateString;
  unreadCount: number;
  /**
   * Always `false` from the service — presence lives on the socket, which a
   * plain async function cannot subscribe to. The widget overlays live
   * presence from `useSocket()`.
   */
  isOnline: boolean;
}

/** Notification joined with its actor's display info — same merged-view
 * pattern as `User` (TRD.md models Users/Profiles separately; the frontend
 * doesn't). See docs/ASSUMPTIONS.md. */
export interface NotificationWithActor extends Notification {
  actorName: string | null;
  actorAvatarUrl: string | null;
}
