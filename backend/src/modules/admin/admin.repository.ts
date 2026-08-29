import { Prisma } from "@prisma/client";
import type { ModerationStatus, UserRole } from "@prisma/client";

import { prisma } from "../../database/prisma.js";
import type { WeekBucket } from "./admin.access.js";

/**
 * Data access for administration (Phase 11).
 *
 * The only file in this module that touches Prisma.
 *
 * ## What is *not* here
 *
 * There is **no status write and no role write in this file.** Both mutate a
 * user's standing, both must produce a `ModerationAction` and an `AuditLog` in
 * the same transaction (ruling R9), and that transaction already exists in
 * `moderation.repository.recordModerationAction`. Adding a second write path
 * here would be a way to change `User.status` without a moderation record —
 * precisely what R9 forbids — so `admin.service.ts` calls the moderation
 * repository instead. This file reads.
 *
 * The one exception is `updateUserRole`, which has no moderation verb to
 * express it (`ModerationActionType` has no `role_change` member) and so
 * carries its own transaction with its own audit insert, on the same
 * all-or-nothing terms.
 */

/* ── Projections ─────────────────────────────────────────────────────────── */

/**
 * The user-management row.
 *
 * `email` and `passwordHash` are absent by construction. So is
 * `emailVerified`: the table does not render it and this is not the surface
 * for account-recovery detail.
 */
const adminUserSelect = {
  id: true,
  username: true,
  displayName: true,
  builderRank: true,
  role: true,
  status: true,
  createdAt: true,
  projectsCount: true,
  followersCount: true,
  profile: { select: { avatarUrl: true } },
} satisfies Prisma.UserSelect;

export type AdminUserRow = Prisma.UserGetPayload<{ select: typeof adminUserSelect }>;

/* ── Users ───────────────────────────────────────────────────────────────── */

export interface AdminUserFilter {
  role?: UserRole;
  status?: ModerationStatus;
}

function adminUserWhere(filter: AdminUserFilter): Prisma.UserWhereInput {
  return {
    // Soft-deleted accounts are excluded. They cannot be moderated into any
    // meaningful state and listing them would fill the table with tombstones.
    deletedAt: null,
    ...(filter.role !== undefined ? { role: filter.role } : {}),
    ...(filter.status !== undefined ? { status: filter.status } : {}),
  };
}

/**
 * A page of the user-management table, newest account first.
 *
 * Newest-first because the shipped Overview widget is "Recently joined" and
 * the table's own `joinedAt` column is what an administrator scans. `id`
 * breaks the `createdAt` tie so offset paging is total-ordered — the seed
 * inserts its users in one pass and several share a millisecond.
 *
 * Rides `users(createdAt)`, an index Phase 2 added and which this is the first
 * caller to use for a descending scan.
 *
 * The page and the count share one `where` object, so the total can never
 * describe a wider set than the rows — the Phase 10 discipline.
 */
export async function listUsers(
  filter: AdminUserFilter,
  page: { skip: number; take: number },
): Promise<{ rows: AdminUserRow[]; total: number }> {
  const where = adminUserWhere(filter);

  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: adminUserSelect,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: page.skip,
      take: page.take,
    }),
    prisma.user.count({ where }),
  ]);

  return { rows, total };
}

export async function findUserById(userId: string): Promise<AdminUserRow | null> {
  return prisma.user.findUnique({ where: { id: userId }, select: adminUserSelect });
}

/* ── Role changes ────────────────────────────────────────────────────────── */

export interface UpdateRoleInput {
  userId: string;
  nextRole: UserRole;
  actorId: string;
  /** The role the caller believed the target held. Guards the write. */
  expectedRole: UserRole;
  auditAction: string;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Changes a user's role and audits it, transactionally.
 *
 * ARCHITECTURE §26 names `ROLE_CHANGED` as an auditable event, and a role
 * grant is the single most consequential write in this module — so the audit
 * row goes in the same transaction as the update, on the same terms as every
 * moderation action.
 *
 * `expectedRole` is in the `where` clause rather than checked beforehand. Two
 * platform admins editing the same account at once is an ordinary race, and a
 * read-then-write would let the later one silently overwrite a decision it
 * never saw. Returns `null` when the row moved on, which the service turns
 * into a 409.
 */
export async function updateUserRole(
  input: UpdateRoleInput,
): Promise<AdminUserRow | null> {
  return prisma.$transaction(async (tx) => {
    const changed = await tx.user.updateMany({
      where: { id: input.userId, role: input.expectedRole },
      data: { role: input.nextRole },
    });

    if (changed.count === 0) return null;

    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        action: input.auditAction,
        targetType: "user",
        targetId: input.userId,
        metadata: { from: input.expectedRole, to: input.nextRole },
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      },
    });

    return tx.user.findUnique({ where: { id: input.userId }, select: adminUserSelect });
  });
}

/* ── Analytics (ruling R15) ──────────────────────────────────────────────── */

/**
 * The four Overview counters.
 *
 * Four `count()` queries in parallel rather than one aggregate, because they
 * span four tables. Soft-deleted rows are excluded everywhere so the numbers
 * describe live content — a "total projects" that counted deleted projects
 * would disagree with every list in the product.
 */
export async function countOverview(): Promise<{
  totalUsers: number;
  totalProjects: number;
  totalCommunities: number;
  pendingReportsCount: number;
}> {
  const [totalUsers, totalProjects, totalCommunities, pendingReportsCount] =
    await Promise.all([
      prisma.user.count({ where: { deletedAt: null } }),
      prisma.project.count({ where: { deletedAt: null } }),
      prisma.community.count({ where: { deletedAt: null } }),
      prisma.report.count({ where: { status: "pending" } }),
    ]);

  return { totalUsers, totalProjects, totalCommunities, pendingReportsCount };
}

/**
 * Signup counts for a set of week buckets.
 *
 * One `count()` per bucket, run in parallel — eight cheap indexed range scans
 * on `users(createdAt)` rather than one query that fetches every signup of the
 * last two months and buckets them in memory. The bucket count is a constant
 * (`SIGNUP_WEEKS`), so this cannot grow into an unbounded fan-out.
 *
 * There is deliberately no `$queryRaw` here. PostgreSQL's `date_trunc` would
 * express this in one statement, but raw SQL is the one thing this phase does
 * not introduce, and eight indexed counts are not the bottleneck on an admin
 * page that loads once.
 */
export async function countSignupsByWeek(
  buckets: readonly WeekBucket[],
): Promise<number[]> {
  return Promise.all(
    buckets.map((bucket) =>
      prisma.user.count({
        where: {
          deletedAt: null,
          createdAt: { gte: bucket.start, lt: bucket.end },
        },
      }),
    ),
  );
}
