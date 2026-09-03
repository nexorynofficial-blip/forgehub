import type { NotificationWithActor } from "@/types";
import { api } from "@/lib/api";

/**
 * Notifications (`backend/src/modules/notifications`).
 *
 * The backend's `NotificationView` carries both shapes the frontend might
 * read: the flat `actorName`/`actorAvatarUrl` pair the shipped panel uses, and
 * a richer nested `actor` for anything wanting a handle to link to. So
 * `NotificationWithActor` needs no adapter.
 *
 * There is no create call and never will be: notifications are produced by the
 * server in response to events, and the API exposes no endpoint to post one.
 */

/** Additive fields beyond the shipped `NotificationWithActor`. */
export interface NotificationItem extends NotificationWithActor {
  entityType: string | null;
  readAt: string | null;
  actor: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
  } | null;
}

export interface NotificationPage {
  items: NotificationItem[];
  nextCursor: string | null;
}

/** `GET /notifications` — cursor-paginated, newest first. */
export async function getNotifications(
  options: { cursor?: string; limit?: number; unreadOnly?: boolean } = {},
): Promise<NotificationPage> {
  return api.get<NotificationPage>("/notifications", {
    query: {
      cursor: options.cursor,
      limit: options.limit,
      unreadOnly: options.unreadOnly,
    },
  });
}

/** `GET /notifications/unread` — just the badge number. */
export async function getUnreadNotificationCount(): Promise<number> {
  const { unreadCount } = await api.get<{ unreadCount: number }>("/notifications/unread");
  return unreadCount;
}

/**
 * `POST /notifications/{id}/read` — one row.
 *
 * The backend answers 404 for a notification belonging to someone else, so
 * ownership needs no client-side check: there is nothing here to get wrong.
 */
export async function markNotificationRead(id: string): Promise<NotificationItem> {
  const { notification } = await api.post<{ notification: NotificationItem }>(
    `/notifications/${encodeURIComponent(id)}/read`,
  );
  return notification;
}

/** `POST /notifications/read-all` — returns how many rows actually flipped. */
export async function markAllNotificationsRead(): Promise<{
  markedRead: number;
  unreadCount: number;
}> {
  return api.post("/notifications/read-all");
}
