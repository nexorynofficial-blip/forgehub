import { Prisma } from "@prisma/client";
import type {
  EntityType,
  ModerationActionType,
  ModerationStatus,
  ReportStatus,
  ReportTargetType,
  UserRole,
} from "@prisma/client";

import { prisma } from "../../database/prisma.js";
import { insertAuditLog } from "../../repositories/audit.repository.js";
import type { AuditActionValue } from "../../utils/audit.js";

/**
 * Data access for moderation (Phase 11).
 *
 * The only file in this module that touches Prisma, as in every module since
 * Phase 4.
 *
 * ## The transactional core (ruling R9)
 *
 * BACKEND_TRD.md §28: *"All important moderation actions must generate audit
 * records."* Every other audit write in this codebase goes through
 * `utils/audit.recordAuditEvent`, which catches and swallows its own failures
 * — the right trade for a login, where losing one record is better than
 * failing the login. It is the wrong trade here: an action that suspended an
 * account but left no record of who did it or why is exactly the outcome §28
 * exists to prevent.
 *
 * So `recordModerationAction` runs one `$transaction` containing, in order:
 *
 *   1. the status change or content removal,
 *   2. the `ModerationAction` row,
 *   3. the `AuditLog` row, written with the same `tx`.
 *
 * Either all three commit or none does. `insertAuditLog` grew one optional
 * parameter to make this possible and behaves exactly as before without it.
 *
 * ## Content removal (ruling R13)
 *
 * Removal reuses each domain's existing `deletedAt` semantics rather than
 * adding a moderator-specific field. That means reproducing each domain's
 * counter side-effects inside this transaction — a comment removal decrements
 * `Post.commentsCount`, a project removal decrements `User.projectsCount`, a
 * community removal releases its tags — because a soft delete that skipped
 * them would leave counters describing rows nobody can see. The counter rules
 * are copied from the owner-facing paths in `posts.repository.ts`,
 * `projects.repository.ts`, and `communities.repository.ts`; the repository
 * tests assert the two agree.
 *
 * The alternative — calling those repositories directly — was rejected because
 * none of them accepts a transaction client, so the removal would commit
 * outside the audit transaction and defeat ruling R9.
 */

/* ── Projections ─────────────────────────────────────────────────────────── */

/**
 * The five-field person shape shared by reporter and target author.
 *
 * `email`, `role`, `status`, and `passwordHash` are absent **by construction**
 * rather than by omission from a wider select — the discipline Phase 9 and
 * Phase 10 both settled on.
 */
const moderationUserSelect = {
  id: true,
  username: true,
  displayName: true,
  builderRank: true,
  profile: { select: { avatarUrl: true } },
} satisfies Prisma.UserSelect;

const reportSelect = {
  id: true,
  reporterId: true,
  targetType: true,
  targetId: true,
  targetAuthorId: true,
  reason: true,
  details: true,
  status: true,
  reviewerId: true,
  resolution: true,
  resolvedAt: true,
  createdAt: true,
} satisfies Prisma.ReportSelect;

const reportDetailSelect = {
  ...reportSelect,
  reporter: { select: moderationUserSelect },
  targetAuthor: { select: moderationUserSelect },
} satisfies Prisma.ReportSelect;

export type ReportRow = Prisma.ReportGetPayload<{ select: typeof reportSelect }>;
export type ReportDetailRow = Prisma.ReportGetPayload<{
  select: typeof reportDetailSelect;
}>;

const moderationActionSelect = {
  id: true,
  moderatorId: true,
  action: true,
  targetType: true,
  targetId: true,
  targetUserId: true,
  reason: true,
  expiresAt: true,
  reportId: true,
  createdAt: true,
} satisfies Prisma.ModerationActionSelect;

export type ModerationActionRow = Prisma.ModerationActionGetPayload<{
  select: typeof moderationActionSelect;
}>;

/* ── Report reads ────────────────────────────────────────────────────────── */

export interface ReportListFilter {
  status?: ReportStatus;
  targetType?: ReportTargetType;
}

function reportWhere(filter: ReportListFilter): Prisma.ReportWhereInput {
  return {
    ...(filter.status !== undefined ? { status: filter.status } : {}),
    ...(filter.targetType !== undefined ? { targetType: filter.targetType } : {}),
  };
}

/**
 * A page of the moderation queue.
 *
 * **Oldest first**, which is what `@@index([status, createdAt])` was built for
 * — the schema comments it as *"The moderation queue: pending first, oldest
 * first."* A queue that surfaced the newest report first would starve the
 * oldest, which is the opposite of what a queue is for. `id` breaks the
 * `createdAt` tie so offset paging is total-ordered and no report can appear
 * on two pages or on none.
 *
 * The page and the count share one `where` object, so the total can never
 * describe a wider set than the rows.
 */
export async function listReports(
  filter: ReportListFilter,
  page: { skip: number; take: number },
): Promise<{ rows: ReportDetailRow[]; total: number }> {
  const where = reportWhere(filter);

  const [rows, total] = await Promise.all([
    prisma.report.findMany({
      where,
      select: reportDetailSelect,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      skip: page.skip,
      take: page.take,
    }),
    prisma.report.count({ where }),
  ]);

  return { rows, total };
}

export async function findReportById(id: string): Promise<ReportDetailRow | null> {
  return prisma.report.findUnique({ where: { id }, select: reportDetailSelect });
}

/** Counts by reason, for `GET /admin/analytics/reports-by-reason`. */
export async function countReportsByReason(): Promise<
  { reason: string; count: number }[]
> {
  const grouped = await prisma.report.groupBy({
    by: ["reason"],
    _count: { _all: true },
  });

  return grouped.map((row) => ({ reason: row.reason, count: row._count._all }));
}

export async function countReportsByStatus(status: ReportStatus): Promise<number> {
  return prisma.report.count({ where: { status } });
}

/* ── Report writes ───────────────────────────────────────────────────────── */

export interface CreateReportInput {
  reporterId: string;
  targetType: ReportTargetType;
  targetId: string;
  targetAuthorId: string | null;
  reason: Prisma.ReportCreateInput["reason"];
  details: string;
  auditAction: AuditActionValue;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Files a report and audits it, transactionally.
 *
 * `status` is not a parameter — it takes the schema default, `pending`. A
 * client cannot file a pre-resolved report, and cannot name a reviewer,
 * because neither field appears here at all.
 */
export async function createReport(input: CreateReportInput): Promise<ReportRow> {
  return prisma.$transaction(async (tx) => {
    const report = await tx.report.create({
      data: {
        reporterId: input.reporterId,
        targetType: input.targetType,
        targetId: input.targetId,
        targetAuthorId: input.targetAuthorId,
        reason: input.reason,
        details: input.details,
      },
      select: reportSelect,
    });

    await insertAuditLog(
      {
        actorId: input.reporterId,
        action: input.auditAction,
        targetType: entityTypeOf(input.targetType),
        targetId: input.targetId,
        metadata: { reportId: report.id, reason: input.reason },
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      },
      tx,
    );

    return report;
  });
}

export interface UpdateReportStatusInput {
  reportId: string;
  status: ReportStatus;
  reviewerId: string;
  resolution: string | null;
  /** Set when the new status closes the report. */
  resolvedAt: Date | null;
  /** The status the caller believed the report was in. Guards the transition. */
  expectedStatus: ReportStatus;
  auditAction: AuditActionValue;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Moves a report to its next state, if it is still in the state the caller saw.
 *
 * Returns `null` when the report has moved on since it was read, which the
 * service turns into a 409. The guard lives in the `where` clause rather than
 * in a read-then-write, because two moderators claiming the same pending
 * report at the same moment is an ordinary race and a read-modify-write would
 * let both succeed — the same discipline `messages.repository.ts` uses for
 * read watermarks.
 */
export async function updateReportStatus(
  input: UpdateReportStatusInput,
): Promise<ReportDetailRow | null> {
  return prisma.$transaction(async (tx) => {
    const moved = await tx.report.updateMany({
      where: { id: input.reportId, status: input.expectedStatus },
      data: {
        status: input.status,
        reviewerId: input.reviewerId,
        resolution: input.resolution,
        resolvedAt: input.resolvedAt,
      },
    });

    if (moved.count === 0) return null;

    await insertAuditLog(
      {
        actorId: input.reviewerId,
        action: input.auditAction,
        targetType: "user",
        targetId: input.reportId,
        metadata: { reportId: input.reportId, status: input.status },
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      },
      tx,
    );

    return tx.report.findUnique({
      where: { id: input.reportId },
      select: reportDetailSelect,
    });
  });
}

/* ── Target resolution ───────────────────────────────────────────────────── */

function entityTypeOf(target: ReportTargetType): EntityType {
  switch (target) {
    case "user":
      return "user";
    case "post":
      return "post";
    case "comment":
      return "comment";
    case "project":
      return "project";
    case "community":
      return "community";
    case "message":
      return "message";
  }
}

export interface ResolvedTarget {
  exists: boolean;
  /** Who authored/owns the target. Equals `targetId` for a `user` target. */
  authorId: string | null;
  /** Set for a comment, whose removal has to decrement its post's counter. */
  parentPostId: string | null;
  alreadyRemoved: boolean;
}

const MISSING: ResolvedTarget = {
  exists: false,
  authorId: null,
  parentPostId: null,
  alreadyRemoved: false,
};

/**
 * Looks up who owns a reportable target, without disclosing its contents.
 *
 * Every branch selects ids and `deletedAt` and nothing else. Resolving the
 * target is how `Report.targetAuthorId` gets filled — the schema keeps it
 * denormalized *"so the queue can show and action them without resolving the
 * target's table first"* — and a report on something that does not exist is
 * refused before a row is written.
 *
 * Soft-deleted rows still resolve. A report filed against a post the author
 * deleted a second earlier is still a legitimate report, and a moderator may
 * still want to act on the author.
 */
export async function resolveTarget(
  targetType: ReportTargetType,
  targetId: string,
): Promise<ResolvedTarget> {
  switch (targetType) {
    case "user": {
      const row = await prisma.user.findUnique({
        where: { id: targetId },
        select: { id: true, deletedAt: true },
      });
      return row === null
        ? MISSING
        : {
            exists: true,
            authorId: row.id,
            parentPostId: null,
            alreadyRemoved: row.deletedAt !== null,
          };
    }
    case "post": {
      const row = await prisma.post.findUnique({
        where: { id: targetId },
        select: { authorId: true, deletedAt: true },
      });
      return row === null
        ? MISSING
        : {
            exists: true,
            authorId: row.authorId,
            parentPostId: null,
            alreadyRemoved: row.deletedAt !== null,
          };
    }
    case "comment": {
      const row = await prisma.comment.findUnique({
        where: { id: targetId },
        select: { authorId: true, postId: true, deletedAt: true },
      });
      return row === null
        ? MISSING
        : {
            exists: true,
            authorId: row.authorId,
            parentPostId: row.postId,
            alreadyRemoved: row.deletedAt !== null,
          };
    }
    case "project": {
      const row = await prisma.project.findUnique({
        where: { id: targetId },
        select: { ownerId: true, deletedAt: true },
      });
      return row === null
        ? MISSING
        : {
            exists: true,
            authorId: row.ownerId,
            parentPostId: null,
            alreadyRemoved: row.deletedAt !== null,
          };
    }
    case "community": {
      const row = await prisma.community.findUnique({
        where: { id: targetId },
        select: { ownerId: true, deletedAt: true },
      });
      return row === null
        ? MISSING
        : {
            exists: true,
            authorId: row.ownerId,
            parentPostId: null,
            alreadyRemoved: row.deletedAt !== null,
          };
    }
    case "message": {
      const row = await prisma.message.findUnique({
        where: { id: targetId },
        select: { senderId: true, deletedAt: true },
      });
      return row === null
        ? MISSING
        : {
            exists: true,
            authorId: row.senderId,
            parentPostId: null,
            alreadyRemoved: row.deletedAt !== null,
          };
    }
  }
}

/** A user's identity fields, for the rank check in `moderation.access.ts`. */
export async function findUserForModeration(
  userId: string,
): Promise<{ id: string; role: UserRole; status: ModerationStatus } | null> {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, status: true },
  });
}

/* ── The transactional action write (rulings R9, R13) ────────────────────── */

/**
 * Removes one piece of content inside an existing transaction, reproducing the
 * owner-facing path's counter side-effects.
 *
 * Returns false when nothing changed — the row was already soft-deleted, or a
 * `user` target, which is not content and is never removed this way. Both are
 * ordinary outcomes: the action is still recorded, because a moderator
 * confirming a removal that already happened is a real decision.
 */
async function removeContent(
  tx: Prisma.TransactionClient,
  targetType: ReportTargetType,
  targetId: string,
  parentPostId: string | null,
): Promise<boolean> {
  const now = new Date();

  switch (targetType) {
    case "user":
      // Accounts are never removed by `content_removal`; banning is the verb
      // for a person. Guarded here so a malformed request cannot soft-delete a
      // user account through the content path.
      return false;

    case "post": {
      const removed = await tx.post.updateMany({
        where: { id: targetId, deletedAt: null },
        data: { deletedAt: now },
      });
      return removed.count > 0;
    }

    case "comment": {
      const removed = await tx.comment.updateMany({
        where: { id: targetId, deletedAt: null },
        data: { deletedAt: now },
      });
      if (removed.count === 0) return false;

      // Mirrors `posts.repository.softDeleteComment`: the count excludes
      // soft-deleted rows, which is how `prisma/seed.ts` recomputes it too.
      if (parentPostId !== null) {
        await tx.post.update({
          where: { id: parentPostId },
          data: { commentsCount: { decrement: removed.count } },
        });
      }
      return true;
    }

    case "project": {
      const project = await tx.project.findUnique({
        where: { id: targetId },
        select: { ownerId: true },
      });
      if (project === null) return false;

      const removed = await tx.project.updateMany({
        where: { id: targetId, deletedAt: null },
        data: { deletedAt: now },
      });
      if (removed.count === 0) return false;

      // Mirrors `projects.repository.softDeleteProject`.
      await tx.user.update({
        where: { id: project.ownerId },
        data: { projectsCount: { decrement: removed.count } },
      });
      return true;
    }

    case "community": {
      const removed = await tx.community.updateMany({
        where: { id: targetId, deletedAt: null },
        data: { deletedAt: now },
      });
      if (removed.count === 0) return false;

      // Mirrors `communities.repository.softDeleteCommunity`, which releases
      // the community's tags so `Tag.usageCount` keeps describing live rows.
      const held = await tx.communityTag.findMany({
        where: { communityId: targetId },
        select: { tagId: true },
      });
      if (held.length > 0) {
        const tagIds = held.map((row) => row.tagId);
        await tx.communityTag.deleteMany({ where: { communityId: targetId } });
        await tx.tag.updateMany({
          where: { id: { in: tagIds }, usageCount: { gt: 0 } },
          data: { usageCount: { decrement: 1 } },
        });
      }
      return true;
    }

    case "message": {
      const removed = await tx.message.updateMany({
        where: { id: targetId, deletedAt: null },
        data: { deletedAt: now },
      });
      return removed.count > 0;
    }
  }
}

export interface RecordActionInput {
  moderatorId: string;
  action: ModerationActionType;
  targetType: ReportTargetType;
  targetId: string;
  /** The account the action lands on; null for a pure content removal. */
  targetUserId: string | null;
  /** The status to write onto `targetUserId`, or null to leave it alone. */
  nextStatus: ModerationStatus | null;
  reason: string;
  expiresAt: Date | null;
  reportId: string | null;
  /** Set only for a content removal, to decrement the parent post's counter. */
  parentPostId: string | null;
  auditAction: AuditActionValue;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface RecordActionResult {
  action: ModerationActionRow;
  statusChanged: boolean;
  contentRemoved: boolean;
}

/**
 * The one write path for every moderation verb.
 *
 * All of it in a single transaction, in this order: mutate, record the action,
 * write the audit row. Ruling R9 in one function — there is no code path that
 * changes a user's standing or removes content without an `AuditLog` row
 * committing alongside it, because there is no second place that performs
 * these mutations.
 */
export async function recordModerationAction(
  input: RecordActionInput,
): Promise<RecordActionResult> {
  return prisma.$transaction(async (tx) => {
    let statusChanged = false;
    let contentRemoved = false;

    if (input.targetUserId !== null && input.nextStatus !== null) {
      // Gated on the status actually differing, so re-banning an already
      // banned account records the decision without pretending it changed
      // something.
      const changed = await tx.user.updateMany({
        where: { id: input.targetUserId, status: { not: input.nextStatus } },
        data: { status: input.nextStatus },
      });
      statusChanged = changed.count > 0;
    }

    if (input.action === "content_removal") {
      contentRemoved = await removeContent(
        tx,
        input.targetType,
        input.targetId,
        input.parentPostId,
      );
    }

    const action = await tx.moderationAction.create({
      data: {
        moderatorId: input.moderatorId,
        action: input.action,
        targetType: entityTypeOf(input.targetType),
        targetId: input.targetId,
        targetUserId: input.targetUserId,
        reason: input.reason,
        expiresAt: input.expiresAt,
        reportId: input.reportId,
      },
      select: moderationActionSelect,
    });

    await insertAuditLog(
      {
        actorId: input.moderatorId,
        action: input.auditAction,
        targetType: entityTypeOf(input.targetType),
        targetId: input.targetId,
        metadata: {
          moderationActionId: action.id,
          action: input.action,
          statusChanged,
          contentRemoved,
          ...(input.expiresAt !== null
            ? { expiresAt: input.expiresAt.toISOString() }
            : {}),
          ...(input.reportId !== null ? { reportId: input.reportId } : {}),
        },
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      },
      tx,
    );

    return { action, statusChanged, contentRemoved };
  });
}

/** Actions taken against one account, newest first. Rides its own index. */
export async function listActionsForUser(
  targetUserId: string,
  take: number,
): Promise<ModerationActionRow[]> {
  return prisma.moderationAction.findMany({
    where: { targetUserId },
    select: moderationActionSelect,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
  });
}
