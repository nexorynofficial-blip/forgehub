import type { AuditLogRow } from "../../repositories/audit.repository.js";
import type { AdminUserRow } from "./admin.repository.js";
import type {
  AdminUserSummaryView,
  AdminUserView,
  AuditLogView,
  ReportsByReasonView,
  WeeklySignupView,
} from "./admin.types.js";

/**
 * The projection layer for administration.
 *
 * Nothing outside this file turns a Prisma row into an admin response — the
 * same chokepoint every module since Phase 4 has used.
 *
 * This is the layer that matters most in this module. Admin endpoints read
 * `User` rows directly, and `User` carries `email`, `passwordHash`, and
 * `emailVerified`. None of them can be emitted by any function below, because
 * none of them is ever named — the projections are built **by construction**,
 * never by taking a row and deleting keys.
 */

function toIso(value: Date): string {
  return value.toISOString();
}

function toAdminUser(row: AdminUserRow): AdminUserView {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: row.profile?.avatarUrl ?? null,
    builderRank: row.builderRank,
  };
}

/**
 * One user-management row.
 *
 * `role` and `status` sit *beside* the nested user rather than inside it,
 * matching the frontend's `AdminUserSummary`. That separation is not
 * cosmetic: `AdminUserView` is the same five-field shape the rest of the API
 * uses for a person, and keeping standing outside it means no other surface
 * can accidentally start serving a role by reusing the person projection.
 */
export function toAdminUserSummary(row: AdminUserRow): AdminUserSummaryView {
  return {
    user: toAdminUser(row),
    role: row.role,
    status: row.status,
    joinedAt: toIso(row.createdAt),
    projectsCount: row.projectsCount,
    followersCount: row.followersCount,
  };
}

export function toWeeklySignups(
  buckets: readonly { weekLabel: string }[],
  counts: readonly number[],
): WeeklySignupView[] {
  return buckets.map((bucket, index) => ({
    weekLabel: bucket.weekLabel,
    count: counts[index] ?? 0,
  }));
}

/**
 * Report counts by reason.
 *
 * Reasons with a zero count are dropped, matching the shipped chart's own
 * `.filter((row) => row.count > 0)` — an empty bar renders as a label with no
 * mark and reads as a rendering bug.
 */
export function toReportsByReason(
  rows: readonly { reason: string; count: number }[],
): ReportsByReasonView[] {
  return rows
    .filter((row) => row.count > 0)
    .map((row) => ({ reason: row.reason, count: row.count }));
}

export function toAuditLogView(row: AuditLogRow): AuditLogView {
  return {
    id: row.id,
    actorId: row.actorId,
    actor:
      row.actor === null
        ? null
        : {
            id: row.actor.id,
            username: row.actor.username,
            displayName: row.actor.displayName,
          },
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    metadata: row.metadata ?? null,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    createdAt: toIso(row.createdAt),
  };
}
