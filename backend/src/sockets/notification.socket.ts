import type { NotificationView } from "../modules/notifications/notifications.types.js";
import { userRoom, type AuthenticatedSocket } from "./auth.socket.js";
import { tryGetSocketServer } from "./socket.js";

/**
 * Real-time notification delivery (ARCHITECTURE §14, §16; TRD §19).
 *
 * The smallest socket module in the codebase, and deliberately so. §16's
 * pipeline ends `Create Notification → Emit Socket.IO Event → Client`, and
 * that is the entire contract: **one server-to-client event, no inbound
 * events at all.**
 *
 * There is no `notification:read` or `notification:mark` frame. Marking read
 * is a REST call, and adding a socket path for it would create a second entry
 * point into the same mutation — a second place for the ownership check to be
 * missing. Phase 8 made the opposite trade for messaging because sending a
 * message is latency-sensitive and marking a notification read is not.
 *
 * ## One payload, always
 *
 * `notification:new` carries `{ notification: NotificationView }` for every
 * notification type, including the `project_update` fan-out. A client must
 * never have to branch on which server-side write path produced a row, so
 * there is exactly one emit function here and it takes a persisted projection
 * — the same one `GET /notifications` returns. Anything that cannot supply
 * that projection has no business emitting on this event.
 *
 * ## Routing
 *
 * `notification:new` goes to `user:{recipientId}` — the room every socket
 * joins at connect from its *verified* handshake identity, never from a
 * client claim. The recipient id itself comes from the persisted row, which
 * the service resolved from a domain event; no client ever names a recipient.
 * Those two facts together are what make cross-user leakage structurally
 * impossible rather than merely unlikely.
 *
 * ## Offline recipients
 *
 * The emit is best-effort and comes *after* persistence. §16 requires
 * notifications to "work even when the recipient is offline", so a missing
 * socket server, a disconnected user, or a dropped frame must all be
 * survivable: the row is already in PostgreSQL and the recipient collects it
 * from `GET /notifications` on their next visit.
 */

/** The one event this module emits. Named by TRD §19 and ARCHITECTURE §14. */
export const NOTIFICATION_NEW_EVENT = "notification:new";

/**
 * Emits a persisted notification to its recipient.
 *
 * No-ops when the Socket.IO server is not running. That is not defensive
 * padding: the REST integration suites exercise notification-producing
 * endpoints with no socket server, and a hard failure there would make
 * real-time delivery a prerequisite for following someone.
 *
 * The recipient is read off `notification.userId` — the persisted row — rather
 * than passed in alongside it. A separate parameter could drift from the row
 * it describes, and a caller that got it wrong would deliver one user's
 * notification into another user's room.
 */
export function emitNotificationNew(notification: NotificationView): void {
  const io = tryGetSocketServer();
  if (!io) return;

  io.to(userRoom(notification.userId)).emit(NOTIFICATION_NEW_EVENT, { notification });
}

/**
 * Emits several notifications, each to its own recipient.
 *
 * Backs the `project_update` fan-out. It is a loop over the single-recipient
 * emit rather than a room broadcast on purpose: there is no room that means
 * "the followers of this project", and inventing one would put a set of users
 * behind a single shared channel where a membership bug leaks one person's
 * notification to another. One emit per recipient keeps the routing property
 * — a notification only ever enters `user:{its own userId}` — intact.
 */
export function emitNotificationsNew(notifications: readonly NotificationView[]): void {
  for (const notification of notifications) emitNotificationNew(notification);
}

/**
 * Registration hook, for symmetry with the message and presence modules.
 *
 * This phase registers **no inbound handlers**, so the function body is empty
 * by design rather than unfinished. It exists so `socket.ts` wires all three
 * feature modules the same way, and so a later phase adding a real inbound
 * notification event has an obvious place to put it instead of reaching into
 * the gateway.
 */
export function registerNotificationHandlers(socket: AuthenticatedSocket): void {
  // The user room join already happened in `registerSocketHandlers`, and that
  // room is the only one notification delivery needs.
  void socket;
}
