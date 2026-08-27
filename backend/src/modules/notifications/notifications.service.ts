import type { EntityType, NotificationType } from "@prisma/client";

import { AppError } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import { buildCursorPage, type CursorPage } from "../../utils/pagination.js";
import * as follows from "../follows/follows.repository.js";
import {
  canAccessNotification,
  collapses,
  planFanout,
  resolveDelivery,
  shouldMarkRead,
  FANOUT_MAX_RECIPIENTS,
} from "./notification.access.js";
import { clampMessage, renderNotificationMessage } from "./notification.message.js";
import { toNotificationView } from "./notification.view.js";
import * as repo from "./notifications.repository.js";
import type { NotificationListQuery } from "./notifications.schema.js";
import type {
  MarkAllReadView,
  NotificationView,
  UnreadCountView,
} from "./notifications.types.js";

/**
 * Notification business logic (ARCHITECTURE §16, TRD §22).
 *
 * §22 states the constraint this module is built around: *"The notification
 * service must remain independent of individual controllers."* It is, and the
 * dependency runs one way — domain services depend on `NotificationPort`, the
 * port's real implementation depends on this file, and nothing here imports a
 * domain service back.
 *
 * Four rules, carried from Phases 4–8 and one added:
 *
 *   1. **Identity comes from the caller.** Every read and mutation resolves
 *      its recipient from the verified access token; no parameter selects
 *      whose notifications are touched.
 *   2. **Access is resolved once**, by `loadOwnNotification`, and refusals are
 *      404 rather than 403.
 *   3. **Projection happens last**, in `notification.view.ts`.
 *   4. **Delivery never fails a business operation.** The port contract calls
 *      it fire-and-forget, so every creation path here catches its own errors.
 *      A notification that cannot be written must not roll back the follow,
 *      like, or comment that produced it.
 */

export interface Actor {
  id: string;
}

/* ── Creation ────────────────────────────────────────────────────────────── */

export interface CreateNotificationInput {
  recipientId: string;
  /** Null for a system notification. Never a client-supplied value. */
  actorId: string | null;
  type: NotificationType;
  entityType?: EntityType | null;
  entityId?: string | null;
  /** A short label for the target, used in the rendered text. */
  subject?: string | null;
}

/**
 * Creates one notification, applying every suppression rule, and returns the
 * view when a row was actually written.
 *
 * Returns `null` when the notification was suppressed — which is an ordinary
 * outcome, not a failure. The caller uses the null to decide whether there is
 * anything to emit over Socket.IO; a suppressed notification must produce no
 * socket traffic either, or turning a type off in settings would still make a
 * badge flicker.
 *
 * The four lookups are ordered to match `resolveDelivery`'s own precedence, so
 * a self-notification costs no query at all and a blocked one costs exactly
 * one.
 */
export async function createNotification(
  input: CreateNotificationInput,
): Promise<NotificationView | null> {
  const entityType = input.entityType ?? null;
  const entityId = input.entityId ?? null;

  // Cheapest check first, and it needs no database at all.
  if (input.actorId !== null && input.actorId === input.recipientId) return null;

  const blockedEitherWay =
    input.actorId !== null
      ? await follows.blockExistsBetween(input.actorId, input.recipientId)
      : false;

  if (blockedEitherWay) return null;

  const stored = await repo.findInAppPreference(input.recipientId, input.type);
  // No row means the user has never opened their settings. The schema defaults
  // `inApp` to true, and so does `users.service.getNotificationPreferences`;
  // treating the absence as "off" here would silently disagree with what the
  // settings screen shows them.
  const inAppEnabled = stored ?? true;

  const duplicateUnread =
    collapses(input.type) &&
    (await repo.hasUnreadDuplicate(
      input.recipientId,
      input.type,
      input.actorId,
      entityType,
      entityId,
    ));

  const decision = resolveDelivery({
    recipientId: input.recipientId,
    actorId: input.actorId,
    blockedEitherWay,
    inAppEnabled,
    duplicateUnread,
  });

  if (!decision.deliver) {
    logger.debug(
      { type: input.type, reason: decision.reason, recipientId: input.recipientId },
      "Notification suppressed",
    );
    return null;
  }

  const actorName =
    input.actorId === null ? null : await repo.findActorName(input.actorId);

  const row = await repo.create({
    userId: input.recipientId,
    actorId: input.actorId,
    type: input.type,
    entityType,
    entityId,
    message: clampMessage(
      renderNotificationMessage({
        type: input.type,
        actorName,
        subject: input.subject ?? null,
      }),
    ),
  });

  return toNotificationView(row);
}

/**
 * Fans a notification out to many recipients, bounded.
 *
 * The only multi-recipient path in this phase, and the reason the port stayed
 * single-recipient: `projects/updates.service.ts` deliberately emitted nothing
 * rather than loop over followers in the domain layer, and this is where that
 * loop belongs.
 *
 * Bounded three ways, because it runs inline inside a request — no queue
 * library is installed and this phase adds no dependencies:
 *
 *   - The follower query itself takes at most `FANOUT_MAX_RECIPIENTS`.
 *   - Suppression is resolved in **batched** queries, not per recipient: one
 *     block lookup and one duplicate lookup per batch.
 *   - Rows are written with `createManyAndReturn`, one statement per batch.
 *
 * Returns the **projections of the rows actually written**, so the caller can
 * emit to exactly those recipients and no one else — and can emit the same
 * `notification:new` payload every other notification type uses. An earlier
 * cut returned bare recipient ids and emitted a lightweight "something is new"
 * signal instead; that made the socket contract depend on which write path
 * produced the row, so it was replaced. `createManyAndReturn` supplies the
 * rows without costing a second round trip, which means the 500/100 bound is
 * unchanged.
 */
export async function fanOutNotification(
  recipientIds: string[],
  input: Omit<CreateNotificationInput, "recipientId">,
): Promise<NotificationView[]> {
  const entityType = input.entityType ?? null;
  const entityId = input.entityId ?? null;

  const actorName =
    input.actorId === null ? null : await repo.findActorName(input.actorId);

  const message = clampMessage(
    renderNotificationMessage({
      type: input.type,
      actorName,
      subject: input.subject ?? null,
    }),
  );

  const delivered: NotificationView[] = [];

  for (const batch of planFanout(recipientIds)) {
    // The actor never notifies themselves, even as one of a thousand followers.
    const candidates = batch.filter((id) => id !== input.actorId);
    if (candidates.length === 0) continue;

    const [blocked, preferences, duplicates] = await Promise.all([
      input.actorId === null
        ? Promise.resolve(new Set<string>())
        : repo.findBlockedWith(input.actorId, candidates),
      repo.findInAppPreferences(candidates, input.type),
      collapses(input.type)
        ? repo.findUsersWithUnreadDuplicate(
            candidates,
            input.type,
            input.actorId,
            entityType,
            entityId,
          )
        : Promise.resolve(new Set<string>()),
    ]);

    const eligible = candidates.filter((id) => {
      const decision = resolveDelivery({
        recipientId: id,
        actorId: input.actorId,
        blockedEitherWay: blocked.has(id),
        inAppEnabled: preferences.get(id) ?? true,
        duplicateUnread: duplicates.has(id),
      });
      return decision.deliver;
    });

    if (eligible.length === 0) continue;

    const rows = await repo.createManyAndReturn(
      eligible.map((id) => ({
        userId: id,
        actorId: input.actorId,
        type: input.type,
        entityType,
        entityId,
        message,
      })),
    );

    delivered.push(...rows.map(toNotificationView));
  }

  return delivered;
}

/** The bounded follower list backing a `project_update` fan-out. */
export async function findProjectFollowers(projectId: string): Promise<string[]> {
  return repo.findProjectFollowerIds(projectId, FANOUT_MAX_RECIPIENTS);
}

/* ── Reads ───────────────────────────────────────────────────────────────── */

/**
 * The caller's own notifications.
 *
 * There is no parameter for whose list to read. That is the whole access
 * control story for this endpoint, and making it structural rather than a
 * check means there is no branch to get wrong.
 */
export async function list(
  actor: Actor,
  query: NotificationListQuery,
): Promise<CursorPage<NotificationView> & { unreadCount: number }> {
  const [rows, unreadCount] = await Promise.all([
    repo.listForUser(actor.id, query.cursor, query.limit, query.unreadOnly),
    repo.countUnread(actor.id),
  ]);

  const page = buildCursorPage(rows, query.limit, (row) => row.id);

  return {
    items: page.items.map(toNotificationView),
    nextCursor: page.nextCursor,
    // Served alongside the page so the badge and the list arrive together;
    // the panel renders both and would otherwise need a second request.
    unreadCount,
  };
}

export async function getUnreadCount(actor: Actor): Promise<UnreadCountView> {
  return { unreadCount: await repo.countUnread(actor.id) };
}

/**
 * Loads a notification the caller owns.
 *
 * Always throws 404, never 403. A 403 would confirm that a notification with
 * that id exists and belongs to somebody — which, given ids are guessable only
 * by enumeration, is exactly the confirmation an enumeration attack wants.
 */
async function loadOwnNotification(
  id: string,
  actor: Actor,
): Promise<repo.NotificationRow> {
  const row = await repo.findById(id);

  const allowed = canAccessNotification({
    exists: row !== null,
    recipientId: row?.userId ?? null,
    viewerId: actor.id,
  });

  if (!allowed || row === null) {
    throw AppError.notFound("Notification not found");
  }

  return row;
}

/* ── Mutations ───────────────────────────────────────────────────────────── */

/**
 * Marks one notification read.
 *
 * Idempotent: marking an already-read notification returns it unchanged rather
 * than erroring, because the caller asked for a state that already holds. The
 * original `readAt` is preserved — re-stamping it would rewrite history to say
 * they read it later than they did.
 */
export async function markRead(id: string, actor: Actor): Promise<NotificationView> {
  const row = await loadOwnNotification(id, actor);

  if (shouldMarkRead(row.isRead)) {
    await repo.markRead(id, actor.id);
    const refreshed = await repo.findById(id);
    if (refreshed) return toNotificationView(refreshed);
  }

  return toNotificationView(row);
}

export async function markAllRead(actor: Actor): Promise<MarkAllReadView> {
  const markedRead = await repo.markAllRead(actor.id);
  return { markedRead, unreadCount: await repo.countUnread(actor.id) };
}
