import type {
  ModerationActionRow,
  ReportDetailRow,
  ReportRow,
} from "./moderation.repository.js";
import type {
  ModerationActionResultView,
  ModerationActionView,
  ModerationUserView,
  ReportDetailView,
  ReportView,
} from "./moderation.types.js";

/**
 * The projection layer for moderation.
 *
 * Nothing outside this file turns a Prisma row into a moderation response —
 * the same chokepoint `user.view.ts`, `project.view.ts`, `post.view.ts`,
 * `community.view.ts`, `message.view.ts`, `notification.view.ts`, and
 * `search.view.ts` established.
 *
 * Every projection is built **by construction**. None starts from a row and
 * deletes keys, because an omission list starts leaking the day someone adds a
 * column — and the rows passing through here are joined to `User`, which
 * carries `email`, `passwordHash`, `role`, and `status`. None of those can be
 * emitted by any function below, because none of them is ever named.
 */

function toIso(value: Date): string {
  return value.toISOString();
}

function toIsoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/**
 * A person on a report.
 *
 * Five fields, matching the frontend's `PostAuthor`. `avatarUrl` comes from
 * the optional `Profile` relation and is null when there is no row — the same
 * treatment `search.view.ts` gives it.
 */
type UserRelationRow = {
  id: string;
  username: string;
  displayName: string;
  builderRank: string;
  profile: { avatarUrl: string | null } | null;
};

export function toModerationUser(row: UserRelationRow): ModerationUserView {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: row.profile?.avatarUrl ?? null,
    builderRank: row.builderRank,
  };
}

export function toReportView(row: ReportRow): ReportView {
  return {
    id: row.id,
    reporterId: row.reporterId,
    targetType: row.targetType,
    targetId: row.targetId,
    targetAuthorId: row.targetAuthorId,
    reason: row.reason,
    details: row.details,
    status: row.status,
    reviewerId: row.reviewerId,
    resolution: row.resolution,
    resolvedAt: toIsoOrNull(row.resolvedAt),
    createdAt: toIso(row.createdAt),
  };
}

/**
 * A report with its participants.
 *
 * `reporter` tolerates null even though `Report.reporter` is a required
 * relation with `onDelete: Restrict` — the projection reports what it was
 * given rather than asserting an invariant, because a throw here would fail
 * the whole queue page over one malformed row.
 */
export function toReportDetailView(row: ReportDetailRow): ReportDetailView {
  return {
    ...toReportView(row),
    reporter: row.reporter === null ? null : toModerationUser(row.reporter),
    targetAuthor: row.targetAuthor === null ? null : toModerationUser(row.targetAuthor),
  };
}

export function toModerationActionView(row: ModerationActionRow): ModerationActionView {
  return {
    id: row.id,
    moderatorId: row.moderatorId,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    targetUserId: row.targetUserId,
    reason: row.reason,
    expiresAt: toIsoOrNull(row.expiresAt),
    reportId: row.reportId,
    createdAt: toIso(row.createdAt),
  };
}

export function toActionResultView(result: {
  action: ModerationActionRow;
  statusChanged: boolean;
  contentRemoved: boolean;
}): ModerationActionResultView {
  return {
    action: toModerationActionView(result.action),
    statusChanged: result.statusChanged,
    contentRemoved: result.contentRemoved,
  };
}
