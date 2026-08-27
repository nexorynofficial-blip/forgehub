import type { MessagePermission, UserRole } from "@prisma/client";

import { isAdminRole } from "../../middleware/role.middleware.js";
import { AppError } from "../../utils/errors.js";
import { buildCursorPage, type CursorPage } from "../../utils/pagination.js";
import * as follows from "../follows/follows.repository.js";
import * as usersRepo from "../users/users.repository.js";
import {
  canAccessConversation,
  canDeleteMessage,
  canEditMessage,
  canStartDirectConversation,
  shouldAdvanceWatermark,
  type DirectMessageContext,
} from "./message.access.js";
import { toConversationView, toMessageView } from "./message.view.js";
import * as repo from "./messages.repository.js";
import type {
  ConversationListQuery,
  MessageCursorQuery,
  MessageSearchQuery,
  SendMessageInput,
} from "./messages.schema.js";
import type {
  ConversationWithParticipantsView,
  MessageWithSenderView,
  ReadReceiptView,
  UnreadCountView,
} from "./messages.types.js";

/**
 * Messaging business logic (BACKEND_ARCHITECTURE.md §13, TRD §20–21).
 *
 * Owns every authorization decision and touches Prisma only through the
 * repository. The three rules Phases 4–7 established carry over unchanged, and
 * one is added:
 *
 *   1. **Identity comes from the caller, never the payload.** Every method
 *      takes an `Actor` resolved from a verified access token — or, on the
 *      socket path, from the verified handshake. No body, path, or socket
 *      frame selects who is sending.
 *   2. **Access is resolved once, by `loadAccessibleConversation`.** Reads,
 *      sends, receipts, reactions, edits, and deletes all enter through it.
 *      That is how the block rule reaches every surface without being
 *      re-derived per endpoint — and re-forgotten on one of them.
 *   3. **Projection happens last, in `message.view.ts`.** No raw row leaves.
 *   4. **The transport is irrelevant to authorization.** The socket handlers
 *      call the same functions the controllers do. There is no socket-only
 *      path into the data, so there is no second place for a check to be
 *      missing (TRD §20).
 */

export interface Actor {
  id: string;
  role: UserRole;
}

/**
 * A conversation the actor is permitted to use, with everything needed to
 * authorize a write against it.
 */
export interface ConversationContext {
  row: repo.ConversationRow;
  /** Live participants other than the actor. The delivery list. */
  otherParticipantIds: string[];
}

/* ── The gate ────────────────────────────────────────────────────────────── */

/**
 * Loads a conversation and applies the access gate.
 *
 * **This is the single entry point for every conversation-scoped operation.**
 *
 * Always throws 404, never 403. A 403 would confirm the conversation exists,
 * and — in the block case — announce to the blocked party that they have been
 * blocked, which is the one thing the blocking feature exists to avoid saying
 * out loud.
 *
 * The block check runs against **every** other live participant, not just "the
 * other one". Written that way it is already correct for a group conversation:
 * one block anywhere in the room closes it for the blocked party, which is the
 * conservative reading and the only one that does not require re-deciding the
 * rule when groups arrive.
 *
 * Note what is *not* consulted: socket rooms. A socket being in
 * `conversation:{id}` proves it was once authorized, not that it still is —
 * the brief is explicit that room membership is never proof of authorization,
 * and a block landing mid-session must take effect on the very next event.
 */
export async function loadAccessibleConversation(
  conversationId: string,
  actor: Actor,
): Promise<ConversationContext> {
  const row = await repo.findConversationById(conversationId);

  const isMember =
    row !== null && row.members.some((member) => member.userId === actor.id);

  const otherParticipantIds =
    row === null
      ? []
      : row.members
          .filter((member) => member.userId !== actor.id)
          .map((member) => member.userId);

  // Only worth the queries when there is a membership to protect; a
  // non-member is refused on membership alone and never triggers a block scan.
  const blockedEitherWay =
    isMember && otherParticipantIds.length > 0
      ? await isBlockedWithAny(actor.id, otherParticipantIds)
      : false;

  const allowed = canAccessConversation({
    exists: row !== null,
    isMember,
    blockedEitherWay,
  });

  if (!allowed || row === null) {
    throw AppError.notFound("Conversation not found");
  }

  return { row, otherParticipantIds };
}

/** True when a `Block` exists in either direction with any of the given users. */
async function isBlockedWithAny(actorId: string, others: string[]): Promise<boolean> {
  const checks = await Promise.all(
    others.map((otherId) => follows.blockExistsBetween(actorId, otherId)),
  );
  return checks.includes(true);
}

/* ── Starting a conversation ─────────────────────────────────────────────── */

/**
 * Opens (or reuses) a direct conversation with another user.
 *
 * The seven steps the brief specifies, in that order — authenticate, resolve,
 * verify existence, check blocking both ways, resolve the policy, evaluate it,
 * and only then create. Steps 4–6 are gathered here and *decided* by
 * `canStartDirectConversation`, so the ordering is a property of a pure
 * function with its own exhaustive tests rather than of this control flow.
 *
 * Every refusal except "yourself" is a 404 carrying the same message. A
 * distinct 403 for the policy case would turn the endpoint into an oracle:
 * a stranger could discover that someone had set "followers only", and a
 * blocked user could discover the block. `self` is safe to name precisely
 * because it discloses nothing the caller does not already know.
 */
export async function startDirectConversation(
  actor: Actor,
  username: string,
): Promise<{ conversation: ConversationWithParticipantsView; created: boolean }> {
  const recipient = await usersRepo.findByUsername(username);

  const context = await buildDirectMessageContext(actor, recipient);
  const decision = canStartDirectConversation(context);

  if (!decision.allowed) {
    if (decision.reason === "self") {
      throw AppError.validation("You cannot start a conversation with yourself");
    }
    // `not_found`, `blocked`, and `policy` are deliberately indistinguishable.
    throw AppError.notFound("User not found");
  }

  // Non-null by construction: `recipientExists` gated the decision above.
  if (!recipient) throw AppError.notFound("User not found");

  const { conversation, created } = await repo.findOrCreateDirectConversation(
    actor.id,
    recipient.id,
  );

  const view = await projectConversation(conversation, actor.id);
  return { conversation: view, created };
}

/**
 * Gathers the facts `canStartDirectConversation` decides on.
 *
 * The follow lookup is skipped when the policy is `everyone`, which is the
 * default and therefore the common case — there is no point proving a
 * relationship that cannot change the answer.
 */
async function buildDirectMessageContext(
  actor: Actor,
  recipient: { id: string; status: string } | null,
): Promise<DirectMessageContext> {
  const base = {
    isSelf: recipient !== null && recipient.id === actor.id,
    requesterIsAdmin: isAdminRole(actor.role),
  };

  if (recipient === null || recipient.status === "banned") {
    return {
      ...base,
      recipientExists: false,
      blockedEitherWay: false,
      recipientPolicy: "everyone",
      requesterFollowsRecipient: false,
    };
  }

  if (base.isSelf) {
    return {
      ...base,
      recipientExists: true,
      blockedEitherWay: false,
      recipientPolicy: "everyone",
      requesterFollowsRecipient: false,
    };
  }

  const blockedEitherWay = await follows.blockExistsBetween(actor.id, recipient.id);
  const recipientPolicy = await resolveMessagePolicy(recipient.id);

  const requesterFollowsRecipient =
    recipientPolicy === "followers"
      ? await follows.isFollowing(actor.id, recipient.id)
      : false;

  return {
    ...base,
    recipientExists: true,
    blockedEitherWay,
    recipientPolicy,
    requesterFollowsRecipient,
  };
}

/**
 * A user's `whoCanMessage`, defaulting to `everyone`.
 *
 * The default matches `UserSettings.whoCanMessage`'s own schema default and
 * the behaviour of `users.repository.findSettings`. A user who has never
 * opened their settings has no `UserSettings` row at all, and treating that
 * absence as "nobody may message me" would silently mute most of the user base.
 */
async function resolveMessagePolicy(userId: string): Promise<MessagePermission> {
  const settings = await usersRepo.findSettings(userId);
  return settings?.whoCanMessage ?? "everyone";
}

/**
 * Re-checks the recipient's contact policy on an existing direct conversation.
 *
 * Called on **every send**, which the brief requires: *"recipient/member policy
 * must permit messaging"* is listed under `message:send`, not only under
 * conversation creation. The consequence is deliberate and worth stating
 * plainly — if someone switches to "followers only" and you do not follow
 * them, an open thread stops accepting new messages from you. History remains
 * readable to both sides; only the write closes. A policy that applied solely
 * at creation time would be trivially defeated by opening a conversation
 * first and messaging later.
 *
 * Group conversations are exempt by construction: a group's gate is its
 * membership, and applying a pairwise contact preference to a room would mean
 * one member's setting could silence another member's messages to everybody.
 */
async function assertMayStillMessage(
  actor: Actor,
  context: ConversationContext,
): Promise<void> {
  if (context.row.isGroup) return;

  const recipientId = context.otherParticipantIds[0];
  if (recipientId === undefined) return;

  const policy = await resolveMessagePolicy(recipientId);
  if (policy === "everyone") return;

  const followsRecipient = await follows.isFollowing(actor.id, recipientId);
  if (followsRecipient) return;

  // 403, not 404: the conversation's existence is already known to this
  // caller — they are a member and can read it — so there is nothing left to
  // conceal, and a 404 here would read as "your thread vanished".
  throw AppError.authorization("This person only accepts messages from followers");
}

/* ── Conversation reads ──────────────────────────────────────────────────── */

/**
 * Projects one conversation, resolving its last message and unread count.
 *
 * Both are per-viewer, which is why they are computed here rather than being
 * columns: `unreadCount` depends on the viewer's watermark and `lastMessage`
 * must skip messages deleted since `lastMessageAt` was stamped.
 */
async function projectConversation(
  row: repo.ConversationRow,
  viewerId: string,
): Promise<ConversationWithParticipantsView> {
  const [latest, unread] = await Promise.all([
    repo.findLatestMessages([row.id]),
    repo.countUnread(viewerId, [row.id]),
  ]);

  return toConversationView(
    row,
    latest.get(row.id) ?? null,
    unread.get(row.id) ?? 0,
    viewerId,
  );
}

/**
 * The actor's conversation list.
 *
 * Three queries total regardless of page size: the page itself, one batched
 * last-message lookup, and one batched unread count. The naive shape — a
 * `lastMessage` and a `count` per row — is the N+1 that makes an inbox slow,
 * and it is exactly what the brief rules out.
 */
export async function listConversations(
  actor: Actor,
  query: ConversationListQuery,
): Promise<CursorPage<ConversationWithParticipantsView>> {
  const rows = await repo.listConversations(actor.id, query.cursor, query.limit);
  const page = buildCursorPage(rows, query.limit, (row) => row.id);

  const ids = page.items.map((row) => row.id);
  const [latest, unread] = await Promise.all([
    repo.findLatestMessages(ids),
    repo.countUnread(actor.id, ids),
  ]);

  return {
    items: page.items.map((row) =>
      toConversationView(
        row,
        latest.get(row.id) ?? null,
        unread.get(row.id) ?? 0,
        actor.id,
      ),
    ),
    nextCursor: page.nextCursor,
  };
}

export async function getConversation(
  conversationId: string,
  actor: Actor,
): Promise<ConversationWithParticipantsView> {
  const context = await loadAccessibleConversation(conversationId, actor);
  return projectConversation(context.row, actor.id);
}

/* ── Message reads ───────────────────────────────────────────────────────── */

function watermarksOf(
  context: ConversationContext,
): { userId: string; lastReadAt: Date | null }[] {
  return context.row.members.map((member) => ({
    userId: member.userId,
    lastReadAt: member.lastReadAt,
  }));
}

export async function listMessages(
  conversationId: string,
  actor: Actor,
  query: MessageCursorQuery,
): Promise<CursorPage<MessageWithSenderView>> {
  const context = await loadAccessibleConversation(conversationId, actor);
  const rows = await repo.listMessages(conversationId, query.cursor, query.limit);
  const page = buildCursorPage(rows, query.limit, (row) => row.id);
  const members = watermarksOf(context);

  return {
    items: page.items.map((row) => toMessageView(row, members, actor.id)),
    nextCursor: page.nextCursor,
  };
}

/**
 * Search inside one conversation.
 *
 * Enters through the same gate as reading it, so there is no path by which a
 * search returns a message from a thread the caller cannot open. Deleted
 * messages are excluded by the repository, not filtered here — a filter after
 * paging would return short pages.
 */
export async function searchMessages(
  conversationId: string,
  actor: Actor,
  query: MessageSearchQuery,
): Promise<CursorPage<MessageWithSenderView>> {
  const context = await loadAccessibleConversation(conversationId, actor);
  const rows = await repo.searchMessages(
    conversationId,
    query.q,
    query.cursor,
    query.limit,
  );
  const page = buildCursorPage(rows, query.limit, (row) => row.id);
  const members = watermarksOf(context);

  return {
    items: page.items.map((row) => toMessageView(row, members, actor.id)),
    nextCursor: page.nextCursor,
  };
}

/* ── Sending ─────────────────────────────────────────────────────────────── */

export interface SentMessage {
  message: MessageWithSenderView;
  /** DB-resolved delivery list. Never a client-supplied recipient. */
  recipientIds: string[];
  conversationId: string;
}

/**
 * Persists a message and returns it with its authorized recipient list.
 *
 * Ordering is the security property: the conversation gate, then the contact
 * policy, then validation of the payload's shape, then persistence — and only
 * then does the caller emit. Nothing in this function emits anything, which is
 * how the brief's *"do not emit a successful message before persistence
 * succeeds"* is made structural: the socket handler cannot broadcast early
 * because it has nothing to broadcast until this returns.
 *
 * `recipientIds` comes from the conversation's membership rows, so the socket
 * layer never has to decide who may receive a message and never sees a
 * client-supplied recipient at all.
 */
export async function sendMessage(
  conversationId: string,
  actor: Actor,
  input: SendMessageInput,
): Promise<SentMessage> {
  const context = await loadAccessibleConversation(conversationId, actor);
  await assertMayStillMessage(actor, context);

  // A message must carry something. Enforced here rather than in the schema
  // because it is a relationship between two fields, not a property of either.
  if (input.content.length === 0 && input.attachments.length === 0) {
    throw AppError.validation("A message must have content or an attachment");
  }

  const row = await repo.createMessage({
    conversationId,
    senderId: actor.id,
    content: input.content,
    attachments: input.attachments.map((attachment) => ({
      url: attachment.url,
      name: attachment.name,
      type: attachment.type,
      ...(attachment.sizeBytes !== undefined ? { sizeBytes: attachment.sizeBytes } : {}),
    })),
  });

  return {
    message: toMessageView(row, watermarksOf(context), actor.id),
    recipientIds: context.otherParticipantIds,
    conversationId,
  };
}

/* ── Editing and deleting ────────────────────────────────────────────────── */

/**
 * Loads a message the actor may act on, through the conversation gate.
 *
 * The conversation is resolved from the *message row*, not from a client
 * parameter, so there is no way to present a message id alongside a
 * conversation the caller happens to be in and have the pair accepted.
 */
async function loadOwnMessage(
  messageId: string,
  actor: Actor,
): Promise<{ row: repo.MessageRow; context: ConversationContext }> {
  const row = await repo.findMessageById(messageId);
  if (!row || row.deletedAt !== null) {
    throw AppError.notFound("Message not found");
  }

  const context = await loadAccessibleConversation(row.conversationId, actor);
  return { row, context };
}

export async function editMessage(
  messageId: string,
  actor: Actor,
  content: string,
): Promise<MessageWithSenderView> {
  const { row, context } = await loadOwnMessage(messageId, actor);

  if (
    !canEditMessage({
      senderId: row.senderId,
      actorId: actor.id,
      deleted: row.deletedAt !== null,
    })
  ) {
    // 403 rather than 404: the caller is a member of this conversation and has
    // already read the message, so its existence is not a secret. Only the
    // authority to rewrite it is missing, and saying so plainly is honest.
    throw AppError.authorization("You can only edit your own messages");
  }

  const updated = await repo.updateMessageContent(messageId, actor.id, content);
  if (!updated) throw AppError.notFound("Message not found");

  return toMessageView(updated, watermarksOf(context), actor.id);
}

export async function deleteMessage(
  messageId: string,
  actor: Actor,
): Promise<{ id: string; conversationId: string; recipientIds: string[] }> {
  const { row, context } = await loadOwnMessage(messageId, actor);

  if (
    !canDeleteMessage({
      senderId: row.senderId,
      actorId: actor.id,
      deleted: row.deletedAt !== null,
    })
  ) {
    throw AppError.authorization("You can only delete your own messages");
  }

  const deleted = await repo.softDeleteMessage(messageId, actor.id);
  if (!deleted) throw AppError.notFound("Message not found");

  return {
    id: messageId,
    conversationId: row.conversationId,
    recipientIds: context.otherParticipantIds,
  };
}

/* ── Reactions ───────────────────────────────────────────────────────────── */

/**
 * Adds a reaction to a message in an accessible conversation.
 *
 * Reacting is a read-adjacent action: any member may react to any live message
 * in the thread, including their own. What it is *not* is a way to touch a
 * message in a conversation the actor cannot open — which is why it goes
 * through the same gate rather than looking the message up directly.
 */
export async function addReaction(
  messageId: string,
  actor: Actor,
  emoji: string,
): Promise<MessageWithSenderView> {
  const { context } = await loadOwnMessage(messageId, actor);

  await repo.addReaction(messageId, actor.id, emoji);

  const refreshed = await repo.findMessageById(messageId);
  if (!refreshed) throw AppError.notFound("Message not found");

  return toMessageView(refreshed, watermarksOf(context), actor.id);
}

export async function removeReaction(
  messageId: string,
  actor: Actor,
  emoji: string,
): Promise<MessageWithSenderView> {
  const { context } = await loadOwnMessage(messageId, actor);

  await repo.removeReaction(messageId, actor.id, emoji);

  const refreshed = await repo.findMessageById(messageId);
  if (!refreshed) throw AppError.notFound("Message not found");

  return toMessageView(refreshed, watermarksOf(context), actor.id);
}

/* ── Read receipts and unread counts ─────────────────────────────────────── */

/**
 * A moved watermark, plus who should be told.
 *
 * `recipientIds` is resolved through the same gate that authorized the read,
 * so the caller emitting a receipt never has to decide the audience itself —
 * and cannot widen it. Kept off `ReadReceiptView` because it is delivery
 * metadata, not part of the response body.
 */
export interface MarkReadResult {
  receipt: ReadReceiptView;
  recipientIds: string[];
}

/**
 * Moves the actor's read watermark.
 *
 * Only ever the *actor's own* watermark — there is no parameter for whose
 * receipt to update, so no request can mark a conversation read on someone
 * else's behalf. That is the brief's rule for `message:read` and it is
 * enforced by the shape of this function rather than by a check inside it.
 *
 * A named `messageId` is verified to belong to this conversation first: an id
 * borrowed from another thread must not be able to steer the watermark to an
 * unrelated timestamp.
 */
export async function markRead(
  conversationId: string,
  actor: Actor,
  messageId: string | undefined,
): Promise<MarkReadResult> {
  const context = await loadAccessibleConversation(conversationId, actor);

  const target =
    messageId === undefined
      ? await repo.findNewestMessage(conversationId)
      : await resolveTargetMessage(conversationId, messageId);

  const membership = await repo.findMembership(conversationId, actor.id);
  const currentAt = membership?.lastReadAt ?? null;

  if (target === null) {
    // An empty thread. Nothing to mark, and nothing to report as unread.
    return {
      receipt: {
        conversationId,
        lastReadAt: currentAt === null ? null : currentAt.toISOString(),
        lastReadMessageId: membership?.lastReadMessageId ?? null,
        unreadCount: 0,
      },
      recipientIds: context.otherParticipantIds,
    };
  }

  // The pure guard mirrors the SQL guard in `advanceWatermark`. Both exist on
  // purpose: this one is unit-tested and documents the intent, the SQL one is
  // what actually holds under a concurrent write.
  if (shouldAdvanceWatermark(currentAt, target.createdAt)) {
    await repo.advanceWatermark(conversationId, actor.id, target.id, target.createdAt);
  }

  const [refreshed, unreadCount] = await Promise.all([
    repo.findMembership(conversationId, actor.id),
    repo.countUnreadForConversation(actor.id, conversationId),
  ]);

  return {
    receipt: {
      conversationId,
      lastReadAt: refreshed?.lastReadAt?.toISOString() ?? null,
      lastReadMessageId: refreshed?.lastReadMessageId ?? null,
      unreadCount,
    },
    recipientIds: context.otherParticipantIds,
  };
}

async function resolveTargetMessage(
  conversationId: string,
  messageId: string,
): Promise<{ id: string; createdAt: Date } | null> {
  const row = await repo.messageBelongsTo(conversationId, messageId);
  if (!row) throw AppError.notFound("Message not found");
  return { id: messageId, createdAt: row.createdAt };
}

export async function getUnreadCount(
  conversationId: string,
  actor: Actor,
): Promise<UnreadCountView> {
  await loadAccessibleConversation(conversationId, actor);
  const unreadCount = await repo.countUnreadForConversation(actor.id, conversationId);
  return { conversationId, unreadCount };
}

/* ── Socket support ──────────────────────────────────────────────────────── */

/**
 * Whether the actor may currently participate in a conversation.
 *
 * Used by the socket layer before joining a conversation room and before
 * relaying a typing indicator. Returns a boolean rather than throwing, because
 * a socket event answers with an acknowledgement callback rather than an HTTP
 * status — but it is the *same gate*, so a block or a departure closes the
 * socket path at the same instant it closes the REST path.
 */
export async function canParticipate(
  conversationId: string,
  actor: Actor,
): Promise<boolean> {
  try {
    await loadAccessibleConversation(conversationId, actor);
    return true;
  } catch {
    return false;
  }
}

/** Everyone who shares a live conversation with this user. Backs presence fan-out. */
export async function findPresenceAudience(userId: string): Promise<string[]> {
  return repo.findConversationPartnerIds(userId);
}
