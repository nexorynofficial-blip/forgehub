import type { Conversation, RecentConversationPreview } from "@/types";
import { DANA, LENA, THEO } from "@/lib/mock/people";
import { mockMessagesByConversationId } from "@/lib/mock/messages";
import { mockCurrentUser } from "@/lib/mock/users";

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

function lastOf<T>(items: T[]): T {
  return items[items.length - 1];
}

/** Full `Conversation` fixtures (TRD.md §4) — same three 1:1 conversations
 * the dashboard's `RecentConversationPreview` fixtures already established
 * (matching id, participant, last message, unread count), plus one group
 * conversation for the brief's "Discord-style" messaging. `lastMessage` is
 * derived from `mock/messages.ts` rather than duplicated by hand, so the
 * two can't drift apart. See docs/ASSUMPTIONS.md (Phase 09). */
export const mockConversations: Conversation[] = [
  {
    id: "cvo_001",
    participantIds: [mockCurrentUser.id, DANA.id],
    isGroup: false,
    title: null,
    lastMessage: lastOf(mockMessagesByConversationId.cvo_001),
    unreadCount: 2,
  },
  {
    id: "cvo_002",
    participantIds: [mockCurrentUser.id, LENA.id],
    isGroup: false,
    title: null,
    lastMessage: lastOf(mockMessagesByConversationId.cvo_002),
    unreadCount: 0,
  },
  {
    id: "cvo_003",
    participantIds: [mockCurrentUser.id, THEO.id],
    isGroup: false,
    title: null,
    lastMessage: lastOf(mockMessagesByConversationId.cvo_003),
    unreadCount: 1,
  },
  {
    id: "cvo_004",
    participantIds: [mockCurrentUser.id, THEO.id, LENA.id],
    isGroup: true,
    title: "Forge Components",
    lastMessage: lastOf(mockMessagesByConversationId.cvo_004),
    unreadCount: 0,
  },
];

export const mockRecentConversations: RecentConversationPreview[] = [
  {
    id: "cvo_001",
    participantName: "Dana Okafor",
    participantAvatarUrl: null,
    lastMessage: "Can you take a look at the sync conflict PR?",
    lastMessageAt: minutesAgo(12),
    unreadCount: 2,
    isOnline: true,
  },
  {
    id: "cvo_002",
    participantName: "Lena Brandt",
    participantAvatarUrl: null,
    lastMessage: "Loved the new onboarding flow 🎉",
    lastMessageAt: minutesAgo(95),
    unreadCount: 0,
    isOnline: false,
  },
  {
    id: "cvo_003",
    participantName: "Theo Marchetti",
    participantAvatarUrl: null,
    lastMessage: "Sent over the model benchmarks",
    lastMessageAt: minutesAgo(340),
    unreadCount: 1,
    isOnline: true,
  },
];
