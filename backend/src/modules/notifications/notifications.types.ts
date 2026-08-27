import type { EntityType, NotificationType } from "@prisma/client";

/**
 * Response shapes for the notifications module.
 *
 * Mirrors the completed frontend's `Notification` (`src/types/notification.ts`)
 * and `NotificationWithActor` (`src/types/dashboard.ts`), extended under the
 * superset convention `utils/response.ts` established: every key the frontend
 * types declare is present, plus the fields the schema carries that the mock
 * UI never needed (`entityType`, `readAt`, and a full actor projection
 * alongside the flat `actorName`/`actorAvatarUrl` pair it reads today).
 */

export interface NotificationActorView {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface NotificationView {
  id: string;
  userId: string;
  type: NotificationType;
  /** Null for system-generated notifications, per the schema's own comment. */
  actorId: string | null;
  /**
   * The polymorphic target. Named `targetId` rather than `entityId` because
   * that is what the frontend's `Notification` calls it; `entityType` is
   * additive and tells a client how to route the link.
   */
  targetId: string | null;
  entityType: EntityType | null;
  message: string;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;

  /** Flat fields the shipped `NotificationWithActor` reads directly. */
  actorName: string | null;
  actorAvatarUrl: string | null;
  /** The richer projection, for clients that want a handle to link to. */
  actor: NotificationActorView | null;
}

export interface UnreadCountView {
  unreadCount: number;
}

export interface MarkAllReadView {
  /** How many rows this call actually flipped. Zero is a success, not a miss. */
  markedRead: number;
  unreadCount: number;
}
