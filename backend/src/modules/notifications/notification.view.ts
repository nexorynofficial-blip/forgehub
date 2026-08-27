import type { NotificationRow } from "./notifications.repository.js";
import type { NotificationActorView, NotificationView } from "./notifications.types.js";

/**
 * The projection layer for notifications.
 *
 * Nothing outside this file turns a Prisma row into an API response — the same
 * chokepoint `user.view.ts`, `project.view.ts`, `post.view.ts`,
 * `community.view.ts`, and `message.view.ts` established.
 *
 * The actor is projected to four fields and no more. `builderRank`, `role`,
 * `status`, `email`, and everything else on `User` are absent because a
 * notification needs a name, a handle to link to, and an avatar — nothing
 * about the actor's standing on the platform. A notification list is read far
 * more often than any profile, so it is the wrong surface to widen.
 *
 * `Notification.message` is passed through as stored. It was rendered at write
 * time (see `notification.message.ts`) precisely so this layer needs no joins,
 * and re-rendering here would defeat that and quietly change the text of past
 * events.
 *
 * Every projection is built **by construction**. None starts from a row and
 * deletes keys: an omission list starts leaking the day someone adds a column.
 */

function toIso(value: Date): string {
  return value.toISOString();
}

function toIsoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function toActor(row: NotificationRow): NotificationActorView | null {
  if (row.actor === null) return null;

  return {
    id: row.actor.id,
    username: row.actor.username,
    displayName: row.actor.displayName,
    avatarUrl: row.actor.profile?.avatarUrl ?? null,
  };
}

/**
 * One notification.
 *
 * Both the flat `actorName`/`actorAvatarUrl` pair and the nested `actor` are
 * served: the shipped `NotificationWithActor` reads the flat fields, while the
 * nested projection carries the `username` a client needs to link to a
 * profile. Serving both costs two strings and saves the frontend a change.
 *
 * `actorId` survives an actor's account deletion as `null` — the schema uses
 * `onDelete: SetNull` so the notification itself is preserved — and the flat
 * fields go null with it rather than rendering "null" into the UI.
 */
export function toNotificationView(row: NotificationRow): NotificationView {
  const actor = toActor(row);

  return {
    id: row.id,
    userId: row.userId,
    type: row.type,
    actorId: row.actorId,
    targetId: row.entityId,
    entityType: row.entityType,
    message: row.message,
    isRead: row.isRead,
    readAt: toIsoOrNull(row.readAt),
    createdAt: toIso(row.createdAt),
    actorName: actor?.displayName ?? null,
    actorAvatarUrl: actor?.avatarUrl ?? null,
    actor,
  };
}
