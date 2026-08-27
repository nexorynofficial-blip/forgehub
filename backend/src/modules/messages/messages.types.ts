import type { AttachmentType } from "@prisma/client";

import type { UserSummaryView } from "../users/users.types.js";

/**
 * Response shapes for the messaging module (BACKEND_ARCHITECTURE.md §13).
 *
 * These mirror the completed frontend's `src/types/message.ts` and
 * `src/types/messaging.ts` and extend them, following the superset convention
 * `utils/response.ts` established: every key the frontend types are declared
 * with is present, plus the fields the schema carries that the mock UI never
 * needed (`editedAt`, `reactions`). Nothing here is a Prisma row.
 */

export interface MessageAttachmentView {
  id: string;
  url: string;
  type: AttachmentType;
  name: string;
  /** Null when the client did not report a size; never inferred server-side. */
  sizeBytes: number | null;
}

/**
 * One emoji and who used it.
 *
 * Grouped by emoji rather than listed per row: the UI renders a chip per
 * distinct emoji with a count, and a raw reaction list would make the client
 * do the grouping. `reactedByViewer` saves it a second pass to decide whether
 * its own chip is highlighted.
 */
export interface MessageReactionView {
  emoji: string;
  count: number;
  userIds: string[];
  reactedByViewer: boolean;
}

export interface MessageView {
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  attachments: MessageAttachmentView[];
  reactions: MessageReactionView[];
  /**
   * Derived from the per-member read watermarks, never from a receipt table
   * (see `ConversationMember.lastReadAt` in the schema). The sender is always
   * included — you have by definition seen what you just sent.
   */
  seenByUserIds: string[];
  createdAt: string;
  editedAt: string | null;
}

/** A message with its author resolved, mirroring `MessageWithSender`. */
export interface MessageWithSenderView extends MessageView {
  sender: UserSummaryView;
}

export interface ConversationView {
  id: string;
  participantIds: string[];
  isGroup: boolean;
  title: string | null;
  lastMessage: MessageWithSenderView | null;
  unreadCount: number;
  createdAt: string;
  lastMessageAt: string | null;
}

/**
 * A conversation with the *other* participants resolved, mirroring the
 * frontend's `ConversationWithParticipants`. The viewer is excluded from
 * `participants` — the UI derives a direct conversation's label from whoever
 * is left — but retained in `participantIds`.
 */
export interface ConversationWithParticipantsView extends ConversationView {
  participants: UserSummaryView[];
}

export interface UnreadCountView {
  conversationId: string;
  unreadCount: number;
}

export interface ReadReceiptView {
  conversationId: string;
  lastReadAt: string | null;
  lastReadMessageId: string | null;
  unreadCount: number;
}
