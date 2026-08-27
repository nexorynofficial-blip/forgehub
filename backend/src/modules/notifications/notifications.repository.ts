import { Prisma, type EntityType, type NotificationType } from "@prisma/client";

import { prisma } from "../../database/prisma.js";

/**
 * Data access for notifications (ARCHITECTURE §16).
 *
 * The only layer that touches Prisma. Every query here rides one of the three
 * indexes the Phase 2 schema already declares for this table, and the schema's
 * own comments name their purposes:
 *
 *   - `[userId, createdAt DESC]` — "the panel query"
 *   - `[userId, isRead]`         — "the unread badge count"
 *   - `[actorId]`               — actor cleanup
 *
 * No schema change was required for this phase, and none is made.
 */

const actorSelect = {
  id: true,
  username: true,
  displayName: true,
  profile: { select: { avatarUrl: true } },
} satisfies Prisma.UserSelect;

const notificationSelect = {
  id: true,
  userId: true,
  type: true,
  actorId: true,
  entityType: true,
  entityId: true,
  message: true,
  isRead: true,
  readAt: true,
  createdAt: true,
  actor: { select: actorSelect },
} satisfies Prisma.NotificationSelect;

export type NotificationRow = Prisma.NotificationGetPayload<{
  select: typeof notificationSelect;
}>;

/* ── Reads ───────────────────────────────────────────────────────────────── */

/**
 * One page of a user's notifications, newest first.
 *
 * `userId` is a required parameter, not an optional filter. There is no code
 * path through this function that returns another user's rows, which is the
 * property the security suite depends on.
 *
 * `id DESC` breaks ties on `createdAt` so cursor paging stays stable when
 * several notifications land in the same millisecond — which a fan-out makes
 * routine rather than rare.
 */
export async function listForUser(
  userId: string,
  cursor: string | undefined,
  limit: number,
  unreadOnly: boolean,
): Promise<NotificationRow[]> {
  return prisma.notification.findMany({
    where: { userId, ...(unreadOnly ? { isRead: false } : {}) },
    select: notificationSelect,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    // Over-fetch by one: the extra row proves more data exists without a
    // second COUNT (see `utils/pagination.buildCursorPage`).
    take: limit + 1,
    ...(cursor !== undefined ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}

/** Rides `[userId, isRead]`. Loads no rows. */
export async function countUnread(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, isRead: false } });
}

export async function findById(id: string): Promise<NotificationRow | null> {
  return prisma.notification.findUnique({ where: { id }, select: notificationSelect });
}

/**
 * Whether an identical notification is already sitting unread.
 *
 * The collapse rule's only query (see `notification.access.shouldCollapse`).
 * Scoped by recipient first so it rides `[userId, createdAt DESC]`, and it
 * selects a single id rather than a count — the question is "is there one",
 * not "how many".
 *
 * `entityId` is matched including its null case: a `follower` notification has
 * no target, and two follows from the same person must still collapse.
 */
export async function hasUnreadDuplicate(
  userId: string,
  type: NotificationType,
  actorId: string | null,
  entityType: EntityType | null,
  entityId: string | null,
): Promise<boolean> {
  const row = await prisma.notification.findFirst({
    where: { userId, type, actorId, entityType, entityId, isRead: false },
    select: { id: true },
  });
  return row !== null;
}

/* ── Writes ──────────────────────────────────────────────────────────────── */

export interface CreateNotificationData {
  userId: string;
  actorId: string | null;
  type: NotificationType;
  entityType: EntityType | null;
  entityId: string | null;
  message: string;
}

export async function create(data: CreateNotificationData): Promise<NotificationRow> {
  return prisma.notification.create({ data, select: notificationSelect });
}

/**
 * Bulk insert for `project_update`, the one fan-out in this phase.
 *
 * `createManyAndReturn` rather than a loop of `create`: still one statement
 * per batch rather than one per recipient, which is what keeps an inline
 * fan-out inside a request defensible — but it hands back what it wrote.
 *
 * It is given **the same `notificationSelect`** every other read here uses, so
 * a fanned-out row and a singly-created one are indistinguishable by the time
 * they reach the projection layer. That is what lets `notification:new` carry
 * one payload shape for every notification type: batching is a write-path
 * concern and must not be visible in the socket contract.
 *
 * Insert order is not guaranteed to be preserved, so every caller reads the
 * recipient off each returned row rather than pairing rows with the input by
 * position.
 */
export async function createManyAndReturn(
  rows: CreateNotificationData[],
): Promise<NotificationRow[]> {
  if (rows.length === 0) return [];
  return prisma.notification.createManyAndReturn({
    data: rows,
    select: notificationSelect,
  });
}

/**
 * Marks one notification read, scoped to its owner.
 *
 * `userId` is in the `where` clause as well as being checked by the service.
 * Belt and braces on purpose: this is the query that would mutate someone
 * else's row if an authorization check were ever dropped upstream, so it
 * refuses to match a row it does not own regardless of what the caller
 * believed. `isRead: false` makes it idempotent — a second call matches
 * nothing and leaves the original `readAt` intact.
 */
export async function markRead(id: string, userId: string): Promise<boolean> {
  const result = await prisma.notification.updateMany({
    where: { id, userId, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });
  return result.count > 0;
}

/** Marks every unread notification read. Returns how many actually flipped. */
export async function markAllRead(userId: string): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: { userId, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });
  return result.count;
}

/* ── Cross-module reads ──────────────────────────────────────────────────── */

/**
 * The recipient's `inApp` flag for one type.
 *
 * Returns `null` when no preference row exists, letting the service apply the
 * schema default rather than guessing here. A user who has never opened their
 * settings has no rows at all, and treating that absence as "off" would mute
 * the entire feature for most of the user base.
 */
export async function findInAppPreference(
  userId: string,
  type: NotificationType,
): Promise<boolean | null> {
  const row = await prisma.notificationPreference.findUnique({
    where: { userId_type: { userId, type } },
    select: { inApp: true },
  });
  return row?.inApp ?? null;
}

/** The same lookup for many recipients at once, for the fan-out path. */
export async function findInAppPreferences(
  userIds: string[],
  type: NotificationType,
): Promise<Map<string, boolean>> {
  if (userIds.length === 0) return new Map();

  const rows = await prisma.notificationPreference.findMany({
    where: { userId: { in: userIds }, type },
    select: { userId: true, inApp: true },
  });

  return new Map(rows.map((row) => [row.userId, row.inApp]));
}

/** An actor's display name, for rendering the message at write time. */
export async function findActorName(actorId: string): Promise<string | null> {
  const row = await prisma.user.findFirst({
    where: { id: actorId, deletedAt: null },
    select: { displayName: true },
  });
  return row?.displayName ?? null;
}

/**
 * Everyone following a project, bounded.
 *
 * `take` is applied here rather than after loading: the ceiling exists to stop
 * a popular project loading tens of thousands of rows into memory, and a limit
 * applied in application code would not.
 */
export async function findProjectFollowerIds(
  projectId: string,
  limit: number,
): Promise<string[]> {
  const rows = await prisma.projectFollower.findMany({
    where: { projectId },
    select: { userId: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  return rows.map((row) => row.userId);
}

/**
 * Which of these users have blocked, or been blocked by, the actor.
 *
 * One query for the whole fan-out batch rather than one per recipient. The
 * `OR` covers both directions, matching `follows.blockExistsBetween`, and the
 * result is a set of the *other* party's id in each pair.
 */
export async function findBlockedWith(
  actorId: string,
  candidateIds: string[],
): Promise<Set<string>> {
  if (candidateIds.length === 0) return new Set();

  const rows = await prisma.block.findMany({
    where: {
      OR: [
        { blockerId: actorId, blockedId: { in: candidateIds } },
        { blockedId: actorId, blockerId: { in: candidateIds } },
      ],
    },
    select: { blockerId: true, blockedId: true },
  });

  const blocked = new Set<string>();
  for (const row of rows) {
    blocked.add(row.blockerId === actorId ? row.blockedId : row.blockerId);
  }
  return blocked;
}

/** Which of these recipients already have an identical unread notification. */
export async function findUsersWithUnreadDuplicate(
  userIds: string[],
  type: NotificationType,
  actorId: string | null,
  entityType: EntityType | null,
  entityId: string | null,
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();

  const rows = await prisma.notification.findMany({
    where: {
      userId: { in: userIds },
      type,
      actorId,
      entityType,
      entityId,
      isRead: false,
    },
    select: { userId: true },
    distinct: ["userId"],
  });

  return new Set(rows.map((row) => row.userId));
}
