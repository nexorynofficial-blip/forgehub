import type { Server as SocketIOServer } from "socket.io";

import {
  socketConversationSchema,
  socketReadSchema,
  socketSendSchema,
} from "../modules/messages/messages.schema.js";
import * as messages from "../modules/messages/messages.service.js";
import type {
  MessageWithSenderView,
  ReadReceiptView,
} from "../modules/messages/messages.types.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { userRoom, type AuthenticatedSocket, type SocketUser } from "./auth.socket.js";
import { tryGetSocketServer } from "./socket.js";

/**
 * Real-time messaging handlers (BACKEND_ARCHITECTURE.md §13–14, TRD §19–20).
 *
 * The security posture of this file is a single sentence: **a socket frame is
 * exactly as untrusted as an HTTP body, and gets exactly the same treatment.**
 * Concretely —
 *
 *   - Identity is `socket.data.user`, set by the handshake from a verified
 *     access token. Every `userId`, `senderId`, and `actorId` a client sends
 *     is ignored, and the schemas do not even declare those keys, so Zod
 *     strips them before a handler sees the payload.
 *   - Authorization runs through `messages.service`, the same functions the
 *     REST controllers call. There is no socket-only path into the data, so
 *     there is no second place for a check to be missing.
 *   - Room membership is never proof of anything. A socket sitting in
 *     `conversation:{id}` had authorization when it joined; the handlers
 *     re-resolve it from the database on every event, so a block landing
 *     mid-session takes effect on the next frame rather than the next
 *     reconnect.
 *
 * ## Where events go, and why
 *
 * `message:new`, `message:read`, and `message:deleted` are emitted to the
 * **user rooms** of the participants the database says belong to the
 * conversation — never to the conversation room, and never to socket ids.
 * Three reasons, all of which the brief asks for:
 *
 *   1. *Authorization from the database.* The recipient list is `SELECT`ed,
 *      not inferred from who happens to be listening.
 *   2. *No duplicate delivery.* Each socket belongs to exactly one user room,
 *      so a client with the thread open cannot receive the same message twice
 *      — which it would if the event went to both room types.
 *   3. *Delivery while the thread is closed.* An inbox badge has to update for
 *      a user who is not looking at that conversation, and such a user is in
 *      no conversation room.
 *
 * `message:typing` and `message:stop_typing` go to the **conversation room**
 * instead, because that is exactly their audience: only someone with the
 * thread open can see a typing bubble, and a typing event delivered to a
 * closed inbox is noise. Membership is still verified in the database before
 * each relay.
 */

/* ── Rooms ───────────────────────────────────────────────────────────────── */

export function conversationRoom(conversationId: string): string {
  return `conversation:${conversationId}`;
}

/* ── Acknowledgements ────────────────────────────────────────────────────── */

/**
 * The shape every socket handler answers with.
 *
 * A socket event has no status code, so failures need a channel of their own.
 * Mirroring the REST error envelope's `code`/`message` keeps clients able to
 * branch on the same constants over either transport.
 */
type Ack<T> =
  { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

type AckFn<T> = (response: Ack<T>) => void;

function isAckFn<T>(value: unknown): value is AckFn<T> {
  return typeof value === "function";
}

/**
 * Turns a thrown error into an acknowledgement.
 *
 * `AppError`s carry a client-safe message by construction. Anything else is
 * replaced with a generic one and logged, so an internal failure cannot leak
 * a stack trace or a query fragment down a socket — the same rule the HTTP
 * error middleware applies.
 */
function toErrorAck(error: unknown): Ack<never> {
  if (error instanceof AppError) {
    return { ok: false, error: { code: error.code, message: error.message } };
  }

  logger.error({ err: error }, "Unhandled error in message socket handler");
  return {
    ok: false,
    error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" },
  };
}

function respond<T>(ack: unknown, response: Ack<T>): void {
  if (isAckFn<T>(ack)) ack(response);
}

/**
 * Validates a payload against a schema, refusing anything malformed.
 *
 * Returns `null` rather than throwing so a handler can answer the client and
 * stop. A socket that sends garbage gets an error acknowledgement, not a
 * disconnect: the frame is untrusted, but the connection was authenticated and
 * may well be a buggy client rather than an attacker.
 */
function parse<T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
  payload: unknown,
): T | null {
  const result = schema.safeParse(payload);
  return result.success && result.data !== undefined ? result.data : null;
}

/* ── Outbound emits ──────────────────────────────────────────────────────── */

/**
 * Emits to a set of users' personal rooms.
 *
 * No-ops when the Socket.IO server is not running. That is not defensive
 * padding: the REST integration suites exercise the controllers without a
 * socket server, and a hard failure there would make real-time delivery a
 * prerequisite for sending a message over HTTP — precisely the coupling the
 * offline-user rule forbids. A message that persists but reaches no live
 * socket is a *successful* send; the recipient collects it from the thread.
 */
function emitToUsers(userIds: string[], event: string, payload: unknown): void {
  const io: SocketIOServer | null = tryGetSocketServer();
  if (!io || userIds.length === 0) return;

  for (const userId of userIds) {
    io.to(userRoom(userId)).emit(event, payload);
  }
}

/**
 * Fans a newly persisted message out to its authorized recipients.
 *
 * The sender is included so their *other* devices see it — a message typed on
 * a laptop should appear on the phone. The socket that sent it also receives
 * this copy, which is deliberate: it carries the server-assigned id and
 * timestamp, letting a client reconcile its optimistic bubble rather than
 * inventing an id it would then have to fix up.
 */
export function emitMessageNew(sent: {
  message: MessageWithSenderView;
  recipientIds: string[];
}): void {
  emitToUsers([...sent.recipientIds, sent.message.senderId], "message:new", {
    message: sent.message,
  });
}

/**
 * Announces a moved read watermark.
 *
 * The audience is the other participants — so a sender's "seen" tick appears —
 * plus the reader's own other devices, so an inbox badge cleared on the phone
 * clears on the laptop too. `recipientIds` is resolved by the service through
 * the access gate; this function never widens it.
 */
export function emitMessageRead(result: {
  receipt: ReadReceiptView;
  recipientIds: string[];
  readerId: string;
}): void {
  emitToUsers([...result.recipientIds, result.readerId], "message:read", {
    conversationId: result.receipt.conversationId,
    userId: result.readerId,
    lastReadAt: result.receipt.lastReadAt,
    lastReadMessageId: result.receipt.lastReadMessageId,
  });
}

export function emitMessageDeleted(result: {
  id: string;
  conversationId: string;
  recipientIds: string[];
}): void {
  emitToUsers(result.recipientIds, "message:deleted", {
    id: result.id,
    conversationId: result.conversationId,
  });
}

/* ── Handler registration ────────────────────────────────────────────────── */

/**
 * Wires the message events onto one authenticated socket.
 *
 * Called from `registerSocketHandlers` after the user room join, so
 * `socket.data.user` is guaranteed present and every handler below can treat
 * the identity as settled.
 */
export function registerMessageHandlers(socket: AuthenticatedSocket): void {
  const user: SocketUser = socket.data.user;
  const actor: messages.Actor = {
    id: user.id,
    role: user.role as messages.Actor["role"],
  };

  /**
   * Joining a conversation room.
   *
   * Not in the architecture's event list, but the conversation room it *does*
   * specify has to be entered somehow, and the alternative — joining every
   * conversation a user belongs to at connect time — would put a user with a
   * thousand threads into a thousand rooms on every reconnect.
   *
   * The join is authorized against the database. A socket cannot place itself
   * in a room for a conversation it does not belong to, which matters because
   * typing indicators are scoped by room.
   */
  socket.on("conversation:join", (payload: unknown, ack: unknown) => {
    void (async () => {
      try {
        const input = parse(socketConversationSchema, payload);
        if (!input) {
          respond(ack, {
            ok: false,
            error: { code: "VALIDATION_ERROR", message: "Invalid payload" },
          });
          return;
        }

        const allowed = await messages.canParticipate(input.conversationId, actor);
        if (!allowed) {
          // 404 semantics over a socket: the same non-disclosure the REST gate
          // applies. "Not found" and "not yours" must stay indistinguishable.
          respond(ack, {
            ok: false,
            error: { code: "NOT_FOUND", message: "Conversation not found" },
          });
          return;
        }

        await socket.join(conversationRoom(input.conversationId));
        respond(ack, { ok: true, data: { conversationId: input.conversationId } });
      } catch (error) {
        respond(ack, toErrorAck(error));
      }
    })();
  });

  socket.on("conversation:leave", (payload: unknown, ack: unknown) => {
    void (async () => {
      const input = parse(socketConversationSchema, payload);
      if (!input) {
        respond(ack, {
          ok: false,
          error: { code: "VALIDATION_ERROR", message: "Invalid payload" },
        });
        return;
      }

      // No authorization needed to *stop* listening.
      await socket.leave(conversationRoom(input.conversationId));
      respond(ack, { ok: true, data: { conversationId: input.conversationId } });
    })();
  });

  /**
   * `message:send` — the authoritative flow from ARCHITECTURE §13.
   *
   * Every step happens before a single byte is broadcast: validate, then the
   * service resolves membership, block status, and contact policy, then
   * PostgreSQL, and only then `message:new`. If persistence throws, nothing is
   * emitted at all — the client gets an error acknowledgement and no recipient
   * ever saw a message that does not exist.
   */
  socket.on("message:send", (payload: unknown, ack: unknown) => {
    void (async () => {
      try {
        const input = parse(socketSendSchema, payload);
        if (!input) {
          respond(ack, {
            ok: false,
            error: { code: "VALIDATION_ERROR", message: "Invalid payload" },
          });
          return;
        }

        const sent = await messages.sendMessage(input.conversationId, actor, {
          content: input.content,
          attachments: input.attachments,
        });

        emitMessageNew(sent);
        respond(ack, { ok: true, data: { message: sent.message } });
      } catch (error) {
        respond(ack, toErrorAck(error));
      }
    })();
  });

  /**
   * `message:read` — moves only the authenticated user's watermark.
   *
   * The payload has no `userId` field, so there is nothing to spoof: whose
   * receipt moves is decided by the handshake, not the frame.
   */
  socket.on("message:read", (payload: unknown, ack: unknown) => {
    void (async () => {
      try {
        const input = parse(socketReadSchema, payload);
        if (!input) {
          respond(ack, {
            ok: false,
            error: { code: "VALIDATION_ERROR", message: "Invalid payload" },
          });
          return;
        }

        const result = await messages.markRead(
          input.conversationId,
          actor,
          input.messageId,
        );

        emitMessageRead({ ...result, readerId: actor.id });
        respond(ack, { ok: true, data: result.receipt });
      } catch (error) {
        respond(ack, toErrorAck(error));
      }
    })();
  });

  registerTypingHandler(socket, actor, "message:typing");
  registerTypingHandler(socket, actor, "message:stop_typing");
}

/**
 * Typing indicators — ephemeral, never persisted (TRD §19, and the brief:
 * *"do not persist typing events in PostgreSQL"*). Nothing in this path writes.
 *
 * Membership is re-verified on every frame even though the socket must already
 * be in the room to be relaying: the room proves past authorization, and a
 * block or a departure since the join must silence the indicator immediately.
 *
 * The relay carries `userId` taken from the *handshake*, overwriting anything
 * the client sent, so a socket cannot make someone else appear to be typing.
 * `socket.to(...)` excludes the sender, who does not need to be told they are
 * typing.
 */
function registerTypingHandler(
  socket: AuthenticatedSocket,
  actor: messages.Actor,
  event: "message:typing" | "message:stop_typing",
): void {
  socket.on(event, (payload: unknown, ack: unknown) => {
    void (async () => {
      try {
        const input = parse(socketConversationSchema, payload);
        if (!input) {
          respond(ack, {
            ok: false,
            error: { code: "VALIDATION_ERROR", message: "Invalid payload" },
          });
          return;
        }

        const allowed = await messages.canParticipate(input.conversationId, actor);
        if (!allowed) {
          respond(ack, {
            ok: false,
            error: { code: "NOT_FOUND", message: "Conversation not found" },
          });
          return;
        }

        socket.to(conversationRoom(input.conversationId)).emit(event, {
          conversationId: input.conversationId,
          userId: actor.id,
          username: socket.data.user.username,
        });

        respond(ack, { ok: true, data: { conversationId: input.conversationId } });
      } catch (error) {
        respond(ack, toErrorAck(error));
      }
    })();
  });
}
