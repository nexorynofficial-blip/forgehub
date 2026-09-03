import type {
  ConversationWithParticipants,
  MessageWithSender,
  PostAuthor,
} from "@/types";
import { ApiError, api } from "@/lib/api";

/**
 * Messaging (`backend/src/modules/messages`).
 *
 * The REST half. Typing indicators and presence are **not** here — they are
 * ephemeral, never persisted, and arrive over Socket.IO (`lib/socket`). The
 * mock polled for them because there was no socket; polling for something the
 * server pushes would now be strictly worse.
 */

/** Additive fields beyond the shipped `Conversation`. */
export interface Conversation extends ConversationWithParticipants {
  createdAt: string;
  lastMessageAt: string | null;
}

/** One emoji chip on a message, pre-grouped by the server. */
export interface MessageReaction {
  emoji: string;
  count: number;
  userIds: string[];
  reactedByViewer: boolean;
}

/** Additive fields beyond the shipped `MessageWithSender`. */
export interface Message extends MessageWithSender {
  reactions: MessageReaction[];
  editedAt: string | null;
}

interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ReadReceipt {
  conversationId: string;
  lastReadAt: string | null;
  lastReadMessageId: string | null;
  unreadCount: number;
}

/* ── Conversations ────────────────────────────────────────────────────────── */

/**
 * `GET /messages/conversations`.
 *
 * Ordered by the server (most recent activity first), so the client no longer
 * sorts — the mock sorted locally because it held the whole list.
 */
export async function getConversations(
  options: { cursor?: string; limit?: number } = {},
): Promise<CursorPage<Conversation>> {
  return api.get<CursorPage<Conversation>>("/messages/conversations", {
    query: { cursor: options.cursor, limit: options.limit },
  });
}

/** `GET /messages/conversations/{id}`. 404 → null (not yours, or not there). */
export async function getConversationById(id: string): Promise<Conversation | null> {
  try {
    const { conversation } = await api.get<{ conversation: Conversation }>(
      `/messages/conversations/${encodeURIComponent(id)}`,
    );
    return conversation;
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) return null;
    throw error;
  }
}

/**
 * `POST /messages/conversations` — opens (or reuses) a direct conversation.
 *
 * Addressed by **username**, not id: the backend resolves the recipient by
 * handle, and it is idempotent — messaging someone twice returns the existing
 * thread rather than a duplicate.
 */
export async function startConversation(username: string): Promise<Conversation> {
  const { conversation } = await api.post<{
    conversation: Conversation;
    created: boolean;
  }>("/messages/conversations", { username });
  return conversation;
}

/* ── Messages ─────────────────────────────────────────────────────────────── */

/** `GET /messages/conversations/{id}/messages` — cursor-paginated history. */
export async function getMessages(
  conversationId: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<CursorPage<Message>> {
  return api.get<CursorPage<Message>>(
    `/messages/conversations/${encodeURIComponent(conversationId)}/messages`,
    { query: { cursor: options.cursor, limit: options.limit } },
  );
}

/**
 * `POST /messages/conversations/{id}/messages`.
 *
 * Over REST rather than the socket. Both paths exist server-side and both fan
 * out `message:new`, but REST is the one that reports a failure properly — a
 * blocked recipient or a contact-policy refusal comes back as a status code
 * the UI can render, where a socket ack would have to be unwrapped by hand.
 * The sender receives their own `message:new` too, which is how the optimistic
 * bubble reconciles to the server's id.
 *
 * `attachments` is deliberately absent: there is no upload endpoint anywhere
 * in the backend, so there is no way to produce a real attachment URL.
 */
export async function sendMessage(
  conversationId: string,
  content: string,
): Promise<Message> {
  const { message } = await api.post<{ message: Message }>(
    `/messages/conversations/${encodeURIComponent(conversationId)}/messages`,
    { content },
  );
  return message;
}

export async function editMessage(messageId: string, content: string): Promise<Message> {
  const { message } = await api.patch<{ message: Message }>(
    `/messages/${encodeURIComponent(messageId)}`,
    { content },
  );
  return message;
}

export async function deleteMessage(messageId: string): Promise<void> {
  await api.delete(`/messages/${encodeURIComponent(messageId)}`);
}

export async function addReaction(messageId: string, emoji: string): Promise<Message> {
  const { message } = await api.post<{ message: Message }>(
    `/messages/${encodeURIComponent(messageId)}/reactions`,
    { emoji },
  );
  return message;
}

export async function removeReaction(messageId: string, emoji: string): Promise<Message> {
  const { message } = await api.delete<{ message: Message }>(
    `/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}`,
  );
  return message;
}

/* ── Read state ───────────────────────────────────────────────────────────── */

/**
 * `POST /messages/conversations/{id}/read` — moves this viewer's watermark.
 *
 * The body is **always** sent, even when empty. `messageId` is optional but
 * the object is not: omitting the body entirely makes the request arrive with
 * no JSON at all, and the schema rejects it with
 * `"expected object, received undefined"` — a 422 on every thread open, since
 * the common case passes no message id. Verified against the running backend.
 */
export async function markConversationRead(
  conversationId: string,
  messageId?: string,
): Promise<ReadReceipt> {
  return api.post<ReadReceipt>(
    `/messages/conversations/${encodeURIComponent(conversationId)}/read`,
    messageId ? { messageId } : {},
  );
}

export async function getUnreadCount(
  conversationId: string,
): Promise<{ conversationId: string; unreadCount: number }> {
  return api.get(`/messages/conversations/${encodeURIComponent(conversationId)}/unread`);
}

/**
 * The other party in a direct conversation.
 *
 * The server already excludes the viewer from `participants`, so this is just
 * "the first one left" rather than a filter against a current-user id — which
 * is what the mock had to do, and what made it import `mockCurrentUser`.
 */
export function otherParticipant(conversation: Conversation): PostAuthor | null {
  return conversation.participants[0] ?? null;
}
