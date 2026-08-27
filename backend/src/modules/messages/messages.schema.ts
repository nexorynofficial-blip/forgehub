import { AttachmentType } from "@prisma/client";
import { z } from "zod";

import { MAX_PAGE_SIZE } from "../../utils/pagination.js";

/**
 * Request validation for the messaging module (BACKEND_TRD.md §15).
 *
 * As in Phases 4–7, what these schemas *omit* is load-bearing. `senderId`,
 * `userId`, `actorId`, `conversationId` in a body, `seenByUserIds`,
 * `createdAt`, `editedAt`, and `lastMessageAt` appear in no write schema at
 * all. Zod strips unknown keys, so a client that posts `senderId` is not
 * rejected — the value simply never reaches a service, which is precisely the
 * defence the socket-security rule asks for (*"never trust client-provided
 * senderId"*). The security suite asserts this rather than trusting the prose.
 */

/* ── Shared field rules ──────────────────────────────────────────────────── */

/**
 * Every id in this module is a `@db.Uuid` column. Validating the format at the
 * edge means a malformed path segment is a 422 from the middleware rather than
 * a Prisma error surfacing as a 500 — and it keeps `/messages/conversations`
 * from ever being parsed as a message id by the `/:messageId` route.
 */
const uuid = z.string().uuid("Must be a valid id");

/**
 * Message body text.
 *
 * Empty is permitted because the schema defaults `content` to `""` and an
 * attachment-only message is a real thing a chat UI sends. The service, not
 * this schema, enforces the rule that a message must carry *something* —
 * content or an attachment — because that is a cross-field condition rather
 * than a property of the string.
 */
const messageContent = z
  .string()
  .trim()
  .max(4000, "A message can be at most 4000 characters");

/**
 * An attachment reference.
 *
 * Deliberately **not** `z.string().url()`, following the Phase 5 and Phase 7
 * precedent for media fields: uploads are a later phase, the shipped fixtures
 * use opaque references rather than absolute URLs, and URL validation would
 * make the API reject its own seed data. Phase 8 accepts a reference and a
 * label; it never fetches, resolves, or stores bytes.
 */
const attachmentUrl = z.string().trim().min(1).max(500);

const attachmentSchema = z.object({
  url: attachmentUrl,
  name: z.string().trim().min(1).max(200),
  type: z.enum(AttachmentType).default("file"),
  /**
   * Client-reported and treated as a label, not a fact — nothing is measured
   * server-side because nothing is stored server-side. Bounded so a caller
   * cannot park an arbitrary integer in the column.
   */
  sizeBytes: z.number().int().nonnegative().max(2_000_000_000).optional(),
});

/** Ten is generous for a chat message and bounds the transactional insert. */
const MAX_ATTACHMENTS = 10;

/* ── Conversations ───────────────────────────────────────────────────────── */

/**
 * Starting a direct conversation.
 *
 * The body names exactly **one** user — the other participant. It cannot name
 * both, and there is no `participantIds` array, because the brief's rule is
 * that *"the authenticated user is always one participant"*. An array would
 * make it syntactically possible to request a conversation the requester is
 * not in, and the only defence would then be a service check that someone
 * could later delete.
 *
 * `username` rather than an id, matching every other user-addressed surface in
 * this API (`/users/:username`, community membership, project members).
 */
export const createConversationSchema = z.object({
  username: z
    .string()
    .trim()
    .min(1, "A recipient is required")
    .max(30, "Must be at most 30 characters"),
});

export type CreateConversationInput = z.infer<typeof createConversationSchema>;

export const conversationParamSchema = z.object({
  conversationId: uuid,
});

export type ConversationParam = z.infer<typeof conversationParamSchema>;

/* ── Messages ────────────────────────────────────────────────────────────── */

export const sendMessageSchema = z.object({
  content: messageContent.default(""),
  attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS).default([]),
});

export type SendMessageInput = z.infer<typeof sendMessageSchema>;

/**
 * Editing changes the text and nothing else.
 *
 * Attachments are absent by design: re-pointing an attachment after the fact
 * would let a sender swap a benign file reference for another one under a
 * message the recipient has already read and possibly already trusted.
 * Deleting and resending is the honest path, and it leaves the timeline true.
 */
export const editMessageSchema = z.object({
  content: messageContent.min(1, "A message cannot be empty"),
});

export type EditMessageInput = z.infer<typeof editMessageSchema>;

export const messageParamSchema = z.object({
  messageId: uuid,
});

export type MessageParam = z.infer<typeof messageParamSchema>;

/* ── Read receipts ───────────────────────────────────────────────────────── */

/**
 * Marking a conversation read.
 *
 * `messageId` is optional: omitting it means "everything currently in this
 * thread", which is what a client that has scrolled to the bottom wants and
 * saves it from having to name the newest id in a race with an inbound
 * message. When supplied, the service verifies the message belongs to this
 * conversation before moving the watermark — an id from another thread must
 * not be able to steer it.
 */
export const markReadSchema = z.object({
  messageId: uuid.optional(),
});

export type MarkReadInput = z.infer<typeof markReadSchema>;

/* ── Reactions ───────────────────────────────────────────────────────────── */

/**
 * A single emoji.
 *
 * Bounded by grapheme-ish length rather than validated against an emoji table:
 * a compound emoji ("👨‍👩‍👧‍👦") is several code points joined by zero-width
 * joiners, so a naive one-character rule would reject perfectly ordinary
 * input. The column is a plain string and the uniqueness constraint is what
 * actually matters; this bound exists so the column cannot be used as free
 * storage.
 */
const emoji = z
  .string()
  .trim()
  .min(1, "An emoji is required")
  .max(32, "Not a valid emoji");

export const addReactionSchema = z.object({ emoji });

export type AddReactionInput = z.infer<typeof addReactionSchema>;

/**
 * Removing a reaction addresses it by emoji in the path.
 *
 * The emoji arrives percent-encoded and Express decodes it before validation,
 * so the same bound applies. The acting user is never in the path — a reaction
 * is removed by whoever placed it, resolved from the access token.
 */
export const reactionParamSchema = z.object({
  messageId: uuid,
  emoji,
});

export type ReactionParam = z.infer<typeof reactionParamSchema>;

/* ── Listing and search ──────────────────────────────────────────────────── */

/**
 * Cursor pagination for message history and conversation lists.
 *
 * Declared here rather than reusing `cursorPaginationSchema` directly so the
 * module owns its own limit ceiling if it ever diverges; the shape and the
 * `MAX_PAGE_SIZE` bound are the shared ones (TRD §8: cursor pagination is
 * preferred for real-time collections, which is exactly what a thread is).
 */
export const messageCursorQuerySchema = z.object({
  cursor: uuid.optional(),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(30),
});

export type MessageCursorQuery = z.infer<typeof messageCursorQuerySchema>;

export const conversationListQuerySchema = z.object({
  cursor: uuid.optional(),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(20),
});

export type ConversationListQuery = z.infer<typeof conversationListQuerySchema>;

/**
 * Search *within* one conversation (ARCHITECTURE §13).
 *
 * There is no `conversationId` in the query and no "search all my messages"
 * variant. The conversation is a path segment, so every search is scoped by
 * the same gate that guards reading the thread, and it is impossible to
 * express a query that spans conversations the caller cannot access. Global
 * search is Phase 10.
 */
export const messageSearchQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(1, "A search term is required")
    .max(100, "Must be at most 100 characters"),
  cursor: uuid.optional(),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(20),
});

export type MessageSearchQuery = z.infer<typeof messageSearchQuerySchema>;

/* ── Socket payloads ─────────────────────────────────────────────────────── */

/**
 * Socket frames are validated by the same schemas as HTTP bodies.
 *
 * A socket payload is exactly as untrusted as a request body — more so, since
 * it skips the HTTP middleware stack entirely. Sharing the schemas means a
 * bound tightened for REST cannot be left loose on the socket path.
 *
 * `conversationId` *is* present here, unlike in HTTP bodies, because a socket
 * event has no path to carry it. It names which conversation to act on; it
 * never asserts that the sender belongs to it, and the handler re-resolves
 * membership from the database on every event.
 */
export const socketSendSchema = z.object({
  conversationId: uuid,
  content: messageContent.default(""),
  attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS).default([]),
});

export type SocketSendInput = z.infer<typeof socketSendSchema>;

export const socketConversationSchema = z.object({
  conversationId: uuid,
});

export type SocketConversationInput = z.infer<typeof socketConversationSchema>;

export const socketReadSchema = z.object({
  conversationId: uuid,
  messageId: uuid.optional(),
});

export type SocketReadInput = z.infer<typeof socketReadSchema>;
