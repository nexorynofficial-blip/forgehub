import { toUserSummary } from "../users/user.view.js";
import { resolveSeenBy } from "./message.access.js";
import type { ConversationRow, MessageRow } from "./messages.repository.js";
import type {
  ConversationView,
  ConversationWithParticipantsView,
  MessageAttachmentView,
  MessageReactionView,
  MessageWithSenderView,
} from "./messages.types.js";

/**
 * The projection layer for messaging.
 *
 * Nothing outside this file turns a Prisma row into an API response — the same
 * chokepoint `user.view.ts`, `project.view.ts`, `post.view.ts`, and
 * `community.view.ts` established. It matters more here than anywhere else in
 * the product: these rows are private correspondence, and "can this endpoint
 * leak a column it shouldn't?" needs exactly one place to check.
 *
 * Columns the repository selects and this layer deliberately never emits:
 *
 *   - **`Message.deletedAt`** — read by the read paths to exclude the row.
 *     Emitting it would let a client tell "deleted" from "never existed",
 *     which is the distinction every 404 in this codebase exists to erase.
 *   - **`Conversation.deletedAt`** — same reasoning at the aggregate level.
 *   - **`ConversationMember.lastReadAt` / `lastReadMessageId`** — the *raw*
 *     watermarks. They are consumed here to derive `seenByUserIds` and the
 *     viewer's own receipt, but never published per member: publishing them
 *     would tell everyone in a thread exactly when each person last looked at
 *     it, which is a surveillance signal nobody asked for and the frontend
 *     never requested.
 *   - **`ConversationMember.isMuted`** — one member's private preference about
 *     their own notifications. It is nobody else's business, and Phase 8 has
 *     no endpoint that sets it.
 *   - **Everything on a sender beyond `UserSummaryView`** — projected through
 *     `toUserSummary`, so no email, no `passwordHash`, no settings.
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

/* ── Message sub-shapes ──────────────────────────────────────────────────── */

function toAttachments(row: MessageRow): MessageAttachmentView[] {
  return row.attachments.map((attachment) => ({
    id: attachment.id,
    url: attachment.url,
    type: attachment.type,
    name: attachment.name,
    sizeBytes: attachment.sizeBytes,
  }));
}

/**
 * Reactions, grouped by emoji.
 *
 * The rows arrive one per (user, emoji); the UI wants one chip per emoji with
 * a count. Grouping here rather than client-side keeps the shape stable for
 * every consumer and lets `reactedByViewer` be answered without shipping the
 * full user list to a client that only wants to know about itself — though the
 * ids are included too, because a hover card naming who reacted is ordinary
 * chat behaviour and the members are people the viewer already shares a
 * conversation with.
 *
 * Insertion order is preserved (the repository orders by `createdAt`), so the
 * chips do not reshuffle between renders.
 */
function toReactions(row: MessageRow, viewerId: string | null): MessageReactionView[] {
  const grouped = new Map<string, string[]>();

  for (const reaction of row.reactions) {
    const users = grouped.get(reaction.emoji);
    if (users) {
      users.push(reaction.userId);
    } else {
      grouped.set(reaction.emoji, [reaction.userId]);
    }
  }

  return [...grouped].map(([emoji, userIds]) => ({
    emoji,
    count: userIds.length,
    userIds,
    reactedByViewer: viewerId !== null && userIds.includes(viewerId),
  }));
}

/* ── Messages ────────────────────────────────────────────────────────────── */

/**
 * A message with its sender resolved.
 *
 * `members` is a required parameter rather than an option with a default,
 * following the `toPoll(row, votedOptionId)` precedent: a caller must decide
 * whose watermarks answer "who has seen this", and forgetting is a compile
 * error rather than a silent "nobody has seen it".
 */
export function toMessageView(
  row: MessageRow,
  members: { userId: string; lastReadAt: Date | null }[],
  viewerId: string | null,
): MessageWithSenderView {
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderId: row.senderId,
    content: row.content,
    attachments: toAttachments(row),
    reactions: toReactions(row, viewerId),
    seenByUserIds: resolveSeenBy(row.senderId, members, row.createdAt),
    createdAt: toIso(row.createdAt),
    editedAt: toIsoOrNull(row.editedAt),
    sender: toUserSummary(row.sender),
  };
}

/* ── Conversations ───────────────────────────────────────────────────────── */

function toConversationBase(
  row: ConversationRow,
  lastMessage: MessageRow | null,
  unreadCount: number,
  viewerId: string,
): ConversationView {
  const watermarks = row.members.map((member) => ({
    userId: member.userId,
    lastReadAt: member.lastReadAt,
  }));

  return {
    id: row.id,
    participantIds: row.members.map((member) => member.userId),
    isGroup: row.isGroup,
    title: row.title,
    lastMessage:
      lastMessage === null ? null : toMessageView(lastMessage, watermarks, viewerId),
    unreadCount,
    createdAt: toIso(row.createdAt),
    lastMessageAt: toIsoOrNull(row.lastMessageAt),
  };
}

/**
 * A conversation with its other participants resolved.
 *
 * The viewer is filtered out of `participants` but kept in `participantIds` —
 * the frontend's `ConversationWithParticipants` documents `participants` as
 * *"every participant except the signed-in user"*, because a direct
 * conversation's label is whoever else is in it. Both fields are served so a
 * client can render a label without losing the full membership.
 */
export function toConversationView(
  row: ConversationRow,
  lastMessage: MessageRow | null,
  unreadCount: number,
  viewerId: string,
): ConversationWithParticipantsView {
  return {
    ...toConversationBase(row, lastMessage, unreadCount, viewerId),
    participants: row.members
      .filter((member) => member.userId !== viewerId)
      .map((member) => toUserSummary(member.user)),
  };
}
