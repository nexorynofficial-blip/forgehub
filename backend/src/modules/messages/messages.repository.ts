import { Prisma, type AttachmentType } from "@prisma/client";
import { createHash } from "node:crypto";

import { prisma } from "../../database/prisma.js";
import { directConversationKey } from "./message.access.js";

/**
 * Data access for messaging (BACKEND_ARCHITECTURE.md §13).
 *
 * Every query here is bounded. There is no "all messages in a conversation"
 * method and no unread count that walks a thread — the brief forbids both, and
 * a DM thread is the one collection in this product with no natural ceiling.
 *
 * Two indexes carry the module and both already exist in the Phase 2 schema:
 * `Message @@index([conversationId, createdAt(sort: Desc)])` for thread
 * paging, and `Conversation @@index([lastMessageAt(sort: Desc)])` for the
 * conversation list. Nothing here required a schema change.
 */

/* ── Selects ─────────────────────────────────────────────────────────────── */

const senderSelect = {
  id: true,
  username: true,
  displayName: true,
  builderRank: true,
  profile: { select: { avatarUrl: true } },
} satisfies Prisma.UserSelect;

const messageSelect = {
  id: true,
  conversationId: true,
  senderId: true,
  content: true,
  createdAt: true,
  editedAt: true,
  deletedAt: true,
  sender: { select: senderSelect },
  attachments: {
    select: { id: true, url: true, type: true, name: true, sizeBytes: true },
    orderBy: { createdAt: "asc" },
  },
  reactions: {
    select: { emoji: true, userId: true },
    orderBy: { createdAt: "asc" },
  },
} satisfies Prisma.MessageSelect;

export type MessageRow = Prisma.MessageGetPayload<{ select: typeof messageSelect }>;

const conversationSelect = {
  id: true,
  isGroup: true,
  title: true,
  createdAt: true,
  lastMessageAt: true,
  deletedAt: true,
  members: {
    // A member who has left keeps their row (so history stays attributable)
    // but stops being a participant. Every consumer of this select treats
    // `members` as the live participant set, so the filter belongs here rather
    // than being re-applied — and re-forgotten — at each call site.
    where: { leftAt: null },
    select: {
      userId: true,
      joinedAt: true,
      lastReadAt: true,
      lastReadMessageId: true,
      isMuted: true,
      user: { select: senderSelect },
    },
    orderBy: { joinedAt: "asc" },
  },
} satisfies Prisma.ConversationSelect;

export type ConversationRow = Prisma.ConversationGetPayload<{
  select: typeof conversationSelect;
}>;

export type ConversationMemberRow = ConversationRow["members"][number];

/* ── Conversation lookup ─────────────────────────────────────────────────── */

export async function findConversationById(id: string): Promise<ConversationRow | null> {
  return prisma.conversation.findFirst({
    where: { id, deletedAt: null },
    select: conversationSelect,
  });
}

/**
 * The other live participants of a conversation, as ids.
 *
 * This is the authoritative recipient list. Delivery resolves it from here on
 * every send rather than from the socket room or the client's payload, which
 * is the rule the brief states twice: *"resolve recipients from the
 * conversation membership in the database"*.
 */
export async function findParticipantIds(conversationId: string): Promise<string[]> {
  const rows = await prisma.conversationMember.findMany({
    where: { conversationId, leftAt: null },
    select: { userId: true },
  });
  return rows.map((row) => row.userId);
}

export async function findMembership(
  conversationId: string,
  userId: string,
): Promise<{ lastReadAt: Date | null; lastReadMessageId: string | null } | null> {
  return prisma.conversationMember.findFirst({
    where: { conversationId, userId, leftAt: null },
    select: { lastReadAt: true, lastReadMessageId: true },
  });
}

/* ── Direct conversation creation ────────────────────────────────────────── */

/**
 * Turns a canonical pair key into the two 32-bit integers
 * `pg_advisory_xact_lock(int4, int4)` takes.
 *
 * A hash rather than the raw uuids because the lock space is 64 bits and a
 * uuid pair is 256. Collisions are therefore possible and harmless: two
 * unrelated pairs sharing a lock serialize against each other for the few
 * milliseconds the lookup takes, which costs nothing and breaks nothing.
 */
function advisoryLockKeys(a: string, b: string): [number, number] {
  const digest = createHash("sha256").update(directConversationKey(a, b)).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

/**
 * Finds the existing direct conversation between two users, or null.
 *
 * "Exactly these two members" is expressed as a conjunction of two `some`
 * clauses plus a member count, not as an array equality — Prisma has no
 * set-equality operator, and matching on `some` alone would happily return a
 * group conversation that merely *contains* both users. `isGroup: false`
 * carries the same intent declaratively; both are asserted in the repository
 * tests because either one alone is a leak.
 */
export async function findDirectConversation(
  a: string,
  b: string,
  client: Prisma.TransactionClient = prisma,
): Promise<ConversationRow | null> {
  return client.conversation.findFirst({
    where: {
      deletedAt: null,
      isGroup: false,
      members: { every: { userId: { in: [a, b] }, leftAt: null } },
      AND: [
        { members: { some: { userId: a, leftAt: null } } },
        { members: { some: { userId: b, leftAt: null } } },
      ],
    },
    select: conversationSelect,
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Finds or creates the direct conversation between two users.
 *
 * **Why a lock and not a unique index.** Duplicate follows are prevented by
 * `@@unique([followerId, followingId])` — the database arbitrates and the
 * loser gets `P2002`. A conversation pair has no such constraint available:
 * the pair lives in two `ConversationMember` rows, and no index can span them.
 * Adding a denormalized `pairKey` column would work but is a schema change,
 * and the brief requires proving the existing schema insufficient before
 * making one. It is not insufficient — PostgreSQL supplies the arbiter
 * directly.
 *
 * `pg_advisory_xact_lock` is taken on the canonical (sorted) pair key inside
 * the transaction, so two simultaneous "message this person" requests from
 * opposite directions serialize: the first creates, the second blocks, then
 * re-reads and finds it. The lock releases with the transaction, including on
 * rollback, so a failure cannot strand it.
 */
export async function findOrCreateDirectConversation(
  requesterId: string,
  recipientId: string,
): Promise<{ conversation: ConversationRow; created: boolean }> {
  const [keyA, keyB] = advisoryLockKeys(requesterId, recipientId);

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${keyA}::int, ${keyB}::int)`;

    const existing = await findDirectConversation(requesterId, recipientId, tx);
    if (existing) return { conversation: existing, created: false };

    const created = await tx.conversation.create({
      data: {
        isGroup: false,
        // No title: a direct conversation's label is derived from its
        // participants by the client (`getConversationLabel`), so storing one
        // would freeze a display name that can change.
        createdById: requesterId,
        members: {
          create: [{ userId: requesterId }, { userId: recipientId }],
        },
      },
      select: conversationSelect,
    });

    return { conversation: created, created: true };
  });
}

/* ── Conversation list ───────────────────────────────────────────────────── */

/**
 * The viewer's conversations, newest activity first.
 *
 * Ordered by `lastMessageAt DESC` with `id DESC` as the tiebreak, because two
 * conversations can share a timestamp and an unstable sort makes cursor paging
 * skip or repeat rows. A conversation that has never been used sorts last
 * (`nulls: "last"`) rather than jumping to the top of the list.
 */
export async function listConversations(
  userId: string,
  cursor: string | undefined,
  limit: number,
): Promise<ConversationRow[]> {
  return prisma.conversation.findMany({
    where: {
      deletedAt: null,
      members: { some: { userId, leftAt: null } },
    },
    select: conversationSelect,
    orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
    take: limit + 1,
    ...(cursor !== undefined ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}

/**
 * The newest live message of each of several conversations.
 *
 * One query for the whole page rather than one per conversation. `lastMessage`
 * cannot be read off `Conversation` — only `lastMessageAt` is denormalized —
 * and the newest message may since have been deleted, in which case the list
 * must fall back to the one before it rather than show a hole.
 */
export async function findLatestMessages(
  conversationIds: string[],
): Promise<Map<string, MessageRow>> {
  if (conversationIds.length === 0) return new Map();

  const rows = await prisma.message.findMany({
    where: { conversationId: { in: conversationIds }, deletedAt: null },
    select: messageSelect,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    // Bounded: at most every conversation on the page contributing a handful
    // of candidates. The map keeps the first (newest) seen per conversation.
    take: conversationIds.length * 8,
  });

  const latest = new Map<string, MessageRow>();
  for (const row of rows) {
    if (!latest.has(row.conversationId)) latest.set(row.conversationId, row);
  }
  return latest;
}

/* ── Unread counts ───────────────────────────────────────────────────────── */

interface UnreadRow {
  conversationId: string;
  count: bigint;
}

/**
 * Unread counts for a page of conversations, in a single query.
 *
 * Raw SQL because the per-conversation cutoff lives on the *member* row, and
 * Prisma's `groupBy` cannot express "count rows newer than a value that varies
 * per group". The alternative is one `count` per conversation, which is the
 * N+1 the brief rules out with *"unread counts must not require loading every
 * message"* — this loads none, and rides the
 * `(conversationId, createdAt DESC)` index.
 *
 * Three conditions define "unread", and each is deliberate:
 *   - `deletedAt IS NULL` — a deleted message is not owed a read.
 *   - `senderId <> viewer` — your own messages are never unread to you.
 *   - watermark comparison, with a null watermark meaning "read nothing yet",
 *     so a brand-new member sees the whole thread as unread rather than none
 *     of it.
 */
export async function countUnread(
  userId: string,
  conversationIds: string[],
): Promise<Map<string, number>> {
  if (conversationIds.length === 0) return new Map();

  const rows = await prisma.$queryRaw<UnreadRow[]>`
    SELECT m."conversationId" AS "conversationId", COUNT(*) AS "count"
    FROM "messages" m
    JOIN "conversation_members" cm
      ON cm."conversationId" = m."conversationId"
     AND cm."userId" = ${userId}::uuid
     AND cm."leftAt" IS NULL
    WHERE m."conversationId" = ANY(${conversationIds}::uuid[])
      AND m."deletedAt" IS NULL
      AND m."senderId" <> ${userId}::uuid
      AND (cm."lastReadAt" IS NULL OR m."createdAt" > cm."lastReadAt")
    GROUP BY m."conversationId"
  `;

  // COUNT(*) comes back as bigint; Number is safe for any plausible thread and
  // the alternative would put a BigInt into a JSON response.
  return new Map(rows.map((row) => [row.conversationId, Number(row.count)]));
}

export async function countUnreadForConversation(
  userId: string,
  conversationId: string,
): Promise<number> {
  const counts = await countUnread(userId, [conversationId]);
  return counts.get(conversationId) ?? 0;
}

/* ── Message history ─────────────────────────────────────────────────────── */

/**
 * A page of a thread, newest first.
 *
 * `createdAt DESC` is the schema's own index order and what a chat UI needs:
 * it opens at the bottom and pages backwards. `id DESC` breaks ties so paging
 * is stable when several messages share a millisecond.
 */
export async function listMessages(
  conversationId: string,
  cursor: string | undefined,
  limit: number,
): Promise<MessageRow[]> {
  return prisma.message.findMany({
    where: { conversationId, deletedAt: null },
    select: messageSelect,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor !== undefined ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}

/**
 * Search within one conversation.
 *
 * `contains` with `mode: "insensitive"` compiles to `ILIKE '%term%'`. That is
 * a deliberate choice over `to_tsvector`: full-text search stems and tokenizes,
 * which is right for prose but wrong for a chat thread where people search for
 * fragments, handles, and bits of code. It also needs no new index, no new
 * column, and no migration — and ARCHITECTURE §13 asks only that search be
 * "PostgreSQL-compatible", with Phase 10 owning real search.
 *
 * `conversationId` is applied first and is not optional: there is no code path
 * through this function that can search across conversations.
 */
export async function searchMessages(
  conversationId: string,
  term: string,
  cursor: string | undefined,
  limit: number,
): Promise<MessageRow[]> {
  return prisma.message.findMany({
    where: {
      conversationId,
      deletedAt: null,
      content: { contains: term, mode: "insensitive" },
    },
    select: messageSelect,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor !== undefined ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}

export async function findMessageById(id: string): Promise<MessageRow | null> {
  return prisma.message.findUnique({ where: { id }, select: messageSelect });
}

/** Whether a message is live and belongs to the given conversation. */
export async function messageBelongsTo(
  conversationId: string,
  messageId: string,
): Promise<{ createdAt: Date } | null> {
  return prisma.message.findFirst({
    where: { id: messageId, conversationId, deletedAt: null },
    select: { createdAt: true },
  });
}

/* ── Writes ──────────────────────────────────────────────────────────────── */

export interface CreateMessageData {
  conversationId: string;
  senderId: string;
  content: string;
  attachments: {
    url: string;
    name: string;
    /**
     * Required here even though the column has a default. Prisma types the
     * create input's `type` as optional, so borrowing that type would admit
     * `undefined` — and under `exactOptionalPropertyTypes` an explicit
     * `undefined` is not the same as an absent key. The schema already
     * defaults it, so callers pass the validated value.
     */
    type: AttachmentType;
    sizeBytes?: number | undefined;
  }[];
}

/**
 * Persists a message, its attachments, and the conversation's activity stamp
 * in one transaction.
 *
 * `lastMessageAt` is denormalized (the schema says so: *"so the conversation
 * list can sort without joining messages"*), which makes it a second write
 * that must not drift from the first. Both land together or neither does — a
 * message with no stamp would sort to the bottom of every participant's
 * inbox and be effectively invisible.
 *
 * It is set to the message's own `createdAt` rather than `now()`, so the
 * ordering column and the row it describes agree exactly.
 */
export async function createMessage(data: CreateMessageData): Promise<MessageRow> {
  return prisma.$transaction(async (tx) => {
    const message = await tx.message.create({
      data: {
        conversationId: data.conversationId,
        senderId: data.senderId,
        content: data.content,
        ...(data.attachments.length > 0
          ? {
              attachments: {
                create: data.attachments.map((attachment) => ({
                  url: attachment.url,
                  name: attachment.name,
                  type: attachment.type,
                  ...(attachment.sizeBytes !== undefined
                    ? { sizeBytes: attachment.sizeBytes }
                    : {}),
                })),
              },
            }
          : {}),
      },
      select: messageSelect,
    });

    await tx.conversation.update({
      where: { id: data.conversationId },
      data: { lastMessageAt: message.createdAt },
    });

    return message;
  });
}

/**
 * Edits a message's text.
 *
 * Scoped by `senderId` in the `where` as well as being checked by the service.
 * Belt and braces on purpose: this is the query that would rewrite someone
 * else's words if an authorization check were ever dropped upstream, so it
 * refuses to match a row it does not own regardless of what the caller
 * believed.
 */
export async function updateMessageContent(
  messageId: string,
  senderId: string,
  content: string,
): Promise<MessageRow | null> {
  const result = await prisma.message.updateMany({
    where: { id: messageId, senderId, deletedAt: null },
    data: { content, editedAt: new Date() },
  });

  if (result.count === 0) return null;
  return findMessageById(messageId);
}

/**
 * Soft-deletes a message.
 *
 * The schema gives `Message` a `deletedAt` column, and the brief says not to
 * destroy historical records unless the specification requires it. Nothing
 * does. The row, its attachments, and its reactions all survive; the message
 * simply stops being returned by any read path.
 *
 * `lastMessageAt` is deliberately **not** rewound. It is an activity marker,
 * not a pointer to a specific message, and recomputing it on every delete
 * would mean an extra query on a hot path to change a sort key nobody sees.
 * The conversation list resolves the actual last message separately and
 * already skips deleted rows.
 */
export async function softDeleteMessage(
  messageId: string,
  senderId: string,
): Promise<boolean> {
  const result = await prisma.message.updateMany({
    where: { id: messageId, senderId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  return result.count > 0;
}

/* ── Read watermarks ─────────────────────────────────────────────────────── */

/**
 * Moves a member's read watermark forward, never backwards.
 *
 * The monotonicity rule is enforced in the `where` clause, not by reading the
 * current value and comparing in application code. Two devices on the same
 * account marking different points of the thread read at the same moment is an
 * ordinary race, and a read-modify-write would let the older one win. Here the
 * database decides: the update matches no row unless the candidate is strictly
 * newer than what is stored.
 */
export async function advanceWatermark(
  conversationId: string,
  userId: string,
  messageId: string,
  readAt: Date,
): Promise<boolean> {
  const result = await prisma.conversationMember.updateMany({
    where: {
      conversationId,
      userId,
      leftAt: null,
      OR: [{ lastReadAt: null }, { lastReadAt: { lt: readAt } }],
    },
    data: { lastReadAt: readAt, lastReadMessageId: messageId },
  });
  return result.count > 0;
}

/** The newest live message in a thread, used when a client marks read without naming one. */
export async function findNewestMessage(
  conversationId: string,
): Promise<{ id: string; createdAt: Date } | null> {
  return prisma.message.findFirst({
    where: { conversationId, deletedAt: null },
    select: { id: true, createdAt: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

/* ── Reactions ───────────────────────────────────────────────────────────── */

/**
 * Adds a reaction, tolerating a duplicate.
 *
 * `@@unique([messageId, userId, emoji])` is the arbiter, exactly as the
 * follow and community-membership paths use their unique indexes. A double-tap
 * from an impatient client raises `P2002`, which is caught and reported as
 * "already there" rather than a 409 the UI would have to explain — the
 * end state the caller asked for is the end state they get.
 */
export async function addReaction(
  messageId: string,
  userId: string,
  emoji: string,
): Promise<boolean> {
  try {
    await prisma.messageReaction.create({ data: { messageId, userId, emoji } });
    return true;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return false;
    }
    throw error;
  }
}

export async function removeReaction(
  messageId: string,
  userId: string,
  emoji: string,
): Promise<boolean> {
  const result = await prisma.messageReaction.deleteMany({
    where: { messageId, userId, emoji },
  });
  return result.count > 0;
}

/* ── Cross-module reads ──────────────────────────────────────────────────── */

/**
 * Everyone the viewer shares a live conversation with.
 *
 * Backs presence fan-out: an online/offline transition is announced to the
 * people who could plausibly be looking at a chat with this user, and to
 * nobody else. Broadcasting presence to every connected socket would turn a
 * chat feature into a directory of who is at their desk.
 *
 * Bounded by `take` because it runs on every connect and disconnect.
 */
export async function findConversationPartnerIds(
  userId: string,
  limit = 200,
): Promise<string[]> {
  const rows = await prisma.conversationMember.findMany({
    where: {
      leftAt: null,
      userId: { not: userId },
      conversation: {
        deletedAt: null,
        members: { some: { userId, leftAt: null } },
      },
    },
    select: { userId: true },
    distinct: ["userId"],
    take: limit,
  });

  return rows.map((row) => row.userId);
}
