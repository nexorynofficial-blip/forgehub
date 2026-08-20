import { logger } from "../utils/logger.js";

/**
 * Outbound boundary for notification delivery
 * (BACKEND_ARCHITECTURE.md §16, decision J3).
 *
 * §16 requires the notification service to stay independent of the business
 * services that trigger it. Phase 4 needs to *signal* that a follow happened,
 * but the notifications module is Phase 9 — so the seam is declared here and
 * backed by a no-op.
 *
 * The alternative, writing `Notification` rows directly from the follows
 * service, would put notification concerns inside the social graph and give
 * Phase 9 a second write path to hunt down. A port costs one small file and
 * keeps the dependency pointing the right way: domain services depend on this
 * interface, never on the notifications module.
 *
 * Phase 9 replaces `noopNotificationPort` with a real implementation that
 * persists the row and emits the Socket.IO event. Nothing in this file's
 * consumers changes when it does.
 */

/** Notification kinds Phase 4 can raise. A subset of `NotificationType`. */
export type PortNotificationType = "follower";

export interface NotificationEvent {
  /** Who receives it. */
  recipientId: string;
  /** Who caused it. Never a client-supplied id — always the verified actor. */
  actorId: string;
  type: PortNotificationType;
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
      "Notification suppressed — notifications module lands in Phase 9",
    );
    return Promise.resolve();
  },
};

/**
 * The port every service resolves. A module-level binding rather than a DI
 * container: the project has exactly one composition root per port, and
 * Phase 9 swaps this single line.
 */
export const notificationPort: NotificationPort = noopNotificationPort;
