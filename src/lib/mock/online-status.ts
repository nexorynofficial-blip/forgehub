import { DANA, THEO } from "@/lib/mock/people";

/** PRD.md §4.7 "Online Status". Matches the `isOnline` flags already used
 * by the dashboard's `mockRecentConversations` (Phase 04) — Dana and Theo
 * online, Lena offline. */
export const mockOnlineUserIds = new Set([DANA.id, THEO.id]);
