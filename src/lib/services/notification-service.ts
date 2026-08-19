import type { NotificationWithActor } from "@/types";
import { mockNotifications } from "@/lib/mock/notifications";

/** Placeholder for the Notification API (TRD.md §5). Mutates the in-memory
 * fixture array directly — fine for a mock session, resets on reload; a
 * real implementation would call the API and let React Query invalidate. */
const notifications = [...mockNotifications];

/** Returns a fresh array reference every call — `notifications` is mutated
 * in place by `markAllNotificationsRead`, and React Query needs a new
 * top-level reference (not just changed nested fields) to know a refetch
 * actually produced different data and re-render subscribers. See
 * docs/ASSUMPTIONS.md (Phase 10). */
export async function getNotifications(): Promise<NotificationWithActor[]> {
  return [...notifications];
}

export async function markAllNotificationsRead(): Promise<{ success: true }> {
  notifications.forEach((notification) => {
    notification.isRead = true;
  });
  return { success: true };
}
