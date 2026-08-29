import { emitNotificationNew } from "../sockets/notification.socket.js";
import * as notifications from "../modules/notifications/notifications.service.js";
import { logger } from "../utils/logger.js";

/**
 * Outbound boundary for notification delivery
 * (BACKEND_ARCHITECTURE.md §16, decision J3).
 *
 * §16 requires the notification service to stay independent of the business
 * services that trigger it, and TRD §22 repeats it: *"The notification service
 * must remain independent of individual controllers."* This port is how that
 * independence is enforced — domain services depend on the interface below,
 * never on the notifications module, so the dependency arrow points one way
 * and stays that way.
 *
 * **Phase 9 replaced the no-op with `liveNotificationPort`.** The promise the
 * Phase 4 version of this file made — *"Nothing in this file's consumers
 * changes when it does"* — was kept: not one of the seven call sites in
 * `follows`, `posts`, and `projects` was touched to activate delivery. Only
 * the binding at the bottom changed.
 *
 * The no-op is retained rather than deleted. It is the honest way to disable
 * notifications in an environment that has no need of them, and it documents
 * what the seam looked like before it was live.
 */

/**
 * Notification kinds a domain service can raise.
 *
 * A subset of the schema's `NotificationType`, and deliberately still a subset
 * after Phase 9:
 *
 *   - **`achievement`** is absent because no awarding engine exists. Adding
 *     the member here would invite a caller before there is anything to call
 *     it for.
 *   - **`moderation`** is **present as of Phase 11**, which owns it. It is the
 *     first member that is normally raised with no actor at all — see
 *     `actorId` below.
 *   - **`invite`** is absent because the two specific members below say the
 *     same thing more precisely, and `NotificationPreference` is keyed by type:
 *     a user who mutes one kind of invitation should not silently mute both.
 *
 * `project_update` **was** absent in Phase 4, on the grounds that it is a
 * fan-out and this port is single-recipient. It is present now because Phase 9
 * owns fan-out — but note that the port itself is still single-recipient. The
 * projects service names one recipient at a time or calls the fan-out helper
 * directly; it never loops over followers itself.
 */
export type PortNotificationType =
  | "follower"
  | "like"
  | "project_invite"
  | "community_invite"
  | "comment"
  | "reply"
  | "mention"
  | "message"
  | "project_update"
  | "moderation";

/**
 * The polymorphic target, mirroring the schema's `(entityType, entityId)`.
 *
 * Widened in Phase 9 to carry `community` and `conversation`, which the
 * community-invite and message triggers need, and in Phase 11 to carry
 * `message`, which a moderator removing one direct message needs. Every member
 * is a value of the schema's `EntityType` enum; the union is written out rather
 * than imported from Prisma so a domain service is not required to import
 * Prisma types to raise a notification.
 */
export type PortEntityType =
  "project" | "user" | "post" | "comment" | "community" | "conversation" | "message";

export interface NotificationEvent {
  /** Who receives it. */
  recipientId: string;
  /**
   * Who caused it. Never a client-supplied id — always the verified actor, or
   * **null for a system notification**.
   *
   * Nullable as of Phase 11. The schema has always allowed it (*"Null for
   * system-generated notifications (achievements, moderation)"*) and
   * `notifications.service.createNotification` has always accepted it; the
   * port was the one link in the chain that did not, because until now every
   * trigger had a person behind it.
   *
   * Moderation is raised with `actorId: null` deliberately, and it buys two
   * things at once. It keeps the acting moderator's identity out of a banned
   * user's notification panel, and it means `resolveDelivery` skips the self
   * and block checks entirely — so a user who blocked the moderator still
   * receives the notice, which ruling R11 requires.
   */
  actorId: string | null;
  type: PortNotificationType;
  /**
   * What the notification is about, for the types that need it. Mirrors the
   * schema's polymorphic `(entityType, entityId)` target so the notifications
   * module can persist the row without re-deriving the subject.
   */
  entityType?: PortEntityType;
  entityId?: string;
  /**
   * A short human label for the target — a project or community name — used in
   * the message rendered at write time.
   *
   * Optional, and supplied by the caller because it already has the row in
   * hand. The alternative is a lookup per notification inside the service to
   * fetch a name the trigger was already holding.
   */
  subject?: string;
}

export interface NotificationPort {
  readonly name: string;
  /**
   * Fire-and-forget by contract: a notification failure must never fail the
   * business operation that produced it.
   */
  emit(event: NotificationEvent): Promise<void>;
}

/**
 * Phase 4 implementation: records the intent at debug level and drops it.
 *
 * Deliberately logs only ids and the type — never message content — so the
 * seam cannot become a channel for leaking user data into logs.
 */
export const noopNotificationPort: NotificationPort = {
  name: "noop",
  emit(event: NotificationEvent): Promise<void> {
    logger.debug(
      { type: event.type, recipientId: event.recipientId, actorId: event.actorId },
      "Notification suppressed — no-op port",
    );
    return Promise.resolve();
  },
};

/**
 * Phase 9 implementation: persist, then emit.
 *
 * The order is §16's and is not negotiable — persistence first, delivery
 * second — because a socket frame sent before the row exists would show a
 * notification that vanishes on refresh, and one sent instead of a row would
 * vanish for a recipient who was offline.
 *
 * **This function never throws.** The port's contract has said so since Phase
 * 4, and it matters more now that there is real work behind it: a failed
 * notification must not roll back the follow, like, comment, or membership
 * change that produced it. Every error is caught, logged with ids only, and
 * swallowed. A user who followed someone successfully has followed them
 * successfully, whether or not the other party ever hears about it.
 *
 * Suppression is not an error. `createNotification` returns `null` when the
 * recipient blocked the actor, muted the type, or already has an identical
 * unread notification — and a suppressed notification produces no socket
 * traffic either, so muting a type in settings does not leave a badge
 * flickering.
 */
export const liveNotificationPort: NotificationPort = {
  name: "live",
  async emit(event: NotificationEvent): Promise<void> {
    try {
      const notification = await notifications.createNotification({
        recipientId: event.recipientId,
        actorId: event.actorId,
        type: event.type,
        entityType: event.entityType ?? null,
        entityId: event.entityId ?? null,
        subject: event.subject ?? null,
      });

      // Null means suppressed, which is an ordinary outcome and emits nothing.
      if (notification === null) return;

      emitNotificationNew(notification);
    } catch (error) {
      logger.error(
        {
          err: error,
          type: event.type,
          recipientId: event.recipientId,
          actorId: event.actorId,
        },
        "Notification delivery failed — the originating operation is unaffected",
      );
    }
  },
};

/**
 * The port every service resolves. A module-level binding rather than a DI
 * container: the project has exactly one composition root per port, and
 * Phase 9 swapped this single line.
 */
export const notificationPort: NotificationPort = liveNotificationPort;
