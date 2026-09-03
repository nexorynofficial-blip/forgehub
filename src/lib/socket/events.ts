import type { MessageWithSender } from "@/types";
import type { NotificationItem } from "@/lib/services/notification-service";

/**
 * The Socket.IO event contract, mirrored from `backend/src/sockets`.
 *
 * Exactly the events the server speaks — no more. An event invented here would
 * be a listener that never fires, or an emit the server drops on the floor.
 */

/* ── Client → server ──────────────────────────────────────────────────────── */

export interface ConversationPayload {
  conversationId: string;
}

export interface SendMessagePayload {
  conversationId: string;
  content: string;
}

export interface ReadPayload {
  conversationId: string;
  messageId?: string;
}

/** Every inbound emit is acknowledged; the server never answers with a throw. */
export type Ack<T> =
  { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

/* ── Server → client ──────────────────────────────────────────────────────── */

export interface MessageNewEvent {
  message: MessageWithSender;
}

export interface MessageDeletedEvent {
  id: string;
  conversationId: string;
}

export interface MessageReadEvent {
  conversationId: string;
  userId: string;
  lastReadAt: string | null;
  lastReadMessageId: string | null;
}

export interface TypingEvent {
  conversationId: string;
  userId: string;
  username: string;
}

/**
 * Presence. The server emits `user:online`/`user:offline` *and*
 * `presence:update` with the same payload — the architecture names one and the
 * realtime spec the other, so it speaks both rather than making a client
 * guess. Listening to `presence:update` alone is sufficient and is what the
 * provider does.
 */
export interface PresenceEvent {
  userId: string;
  online: boolean;
  at: string;
}

export interface NotificationNewEvent {
  notification: NotificationItem;
}

export const SOCKET_EVENTS = {
  conversationJoin: "conversation:join",
  conversationLeave: "conversation:leave",
  messageSend: "message:send",
  messageRead: "message:read",

  messageNew: "message:new",
  messageDeleted: "message:deleted",
  messageTyping: "message:typing",
  messageStopTyping: "message:stop_typing",
  notificationNew: "notification:new",
  userOnline: "user:online",
  userOffline: "user:offline",
  presenceUpdate: "presence:update",
} as const;
