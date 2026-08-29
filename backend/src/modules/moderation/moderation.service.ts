import type {
  ModerationActionType,
  ModerationStatus,
  ReportTargetType,
  UserRole,
} from "@prisma/client";

import { notificationPort } from "../../ports/notification.port.js";
import {
  AuditAction,
  type AuditActionValue,
  type AuditContext,
} from "../../utils/audit.js";
import { AppError } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import { buildPagination, toPrismaOffset } from "../../utils/pagination.js";
import type { Pagination } from "../../utils/response.js";
import {
  actionForStatusChange,
  allowsExpiry,
  canActOnUser,
  canReadModerationQueue,
  canReadReport,
  canTransitionReport,
  closesReport,
  entityTypeForReportTarget,
  notifiesTarget,
  requiresExpiry,
  statusAfterAction,
  targetsContent,
} from "./moderation.access.js";
import * as repo from "./moderation.repository.js";
import type {
  CreateActionBody,
  CreateReportBody,
  ListReportsQuery,
  UpdateReportBody,
} from "./moderation.schema.js";
import type {
  ModerationActionResultView,
  ReportDetailView,
  ReportView,
} from "./moderation.types.js";
import {
  toActionResultView,
  toReportDetailView,
  toReportView,
} from "./moderation.view.js";

/**
 * Moderation business logic (ARCHITECTURE §25, TRD §28, PRD §17).
 *
 * §25 draws the flow this file implements end to end:
 *
 *     User → Report → Report Service → Moderation Queue → Moderator
 *          → Moderation Action → Audit Log
 *
 * Five rules, four carried from Phases 4–10 and one new:
 *
 *   1. **Identity comes from the caller.** Every actor below is built by the
 *      controller from the verified access token. No parameter names a
 *      reporter, reviewer, or moderator.
 *   2. **Authorization is decided by pure predicates** in
 *      `moderation.access.ts`, so the rules are testable without a database.
 *   3. **Projection happens last**, in `moderation.view.ts`.
 *   4. **Refusals are 403 for capability and 404 for existence.** A moderator
 *      denied by rank gets 403 — ARCHITECTURE §18's explicit instruction for
 *      an authorization failure. A report that does not exist gets 404. These
 *      are different questions and Phase 11 answers both, which is why this
 *      module has a 403 where Phases 5–10 deliberately had none.
 *   5. **(New) Mutation and audit commit together.** The repository does this
 *      in one transaction; nothing here may write around it.
 */

export interface Actor {
  id: string;
  role: UserRole;
}

/* ── Reports: creation (rulings R10, R14) ────────────────────────────────── */

/**
 * Files a report.
 *
 * **Blocking is deliberately not consulted** (ruling R10). Everywhere else in
 * this codebase a `Block` outranks membership, ownership, and admin role — the
 * Phase 4 rule the whole social graph is built on. Reporting is the one
 * exception, and it has to be: the person most likely to have blocked a
 * harasser is the person who needs to report them. Refusing the report would
 * make the safety tool that users reach for first fail exactly when it
 * matters. Nothing else about blocking is weakened; a reporter still cannot
 * *see* the blocked user's content, only report it.
 *
 * The target is resolved before the row is written so a report cannot be filed
 * against an id that does not exist, and so `targetAuthorId` is captured from
 * the server's own lookup rather than from the request. Soft-deleted targets
 * still resolve: a post deleted a second before the report was filed is still
 * a legitimate thing to report its author for.
 */
export async function createReport(
  actor: Actor,
  body: CreateReportBody,
  audit: AuditContext,
): Promise<ReportView> {
  const target = await repo.resolveTarget(body.targetType, body.targetId);

  if (!target.exists) {
    // 404, not 422: whether a given id exists is not something an arbitrary
    // caller should be able to probe through a validation message.
    throw AppError.notFound("That content could not be found");
  }

  const row = await repo.createReport({
    reporterId: actor.id,
    targetType: body.targetType,
    targetId: body.targetId,
    targetAuthorId: target.authorId,
    reason: body.reason,
    details: body.details,
    auditAction: AuditAction.REPORT_CREATED,
    ipAddress: audit.ipAddress,
    userAgent: audit.userAgent,
  });

  return toReportView(row);
}

/* ── Reports: the queue ──────────────────────────────────────────────────── */

export interface ReportPage {
  reports: ReportDetailView[];
  pagination: Pagination;
}

/**
 * A page of the moderation queue.
 *
 * Ordered oldest-first by the repository, which is what the schema's
 * `@@index([status, createdAt])` was added for. The `canReadModerationQueue`
 * check is redundant behind `requireAdmin` on the route and is made anyway:
 * a route guard is one edit away from being removed, and this is the layer the
 * unit tests pin.
 */
export async function listReports(
  actor: Actor,
  query: ListReportsQuery,
): Promise<ReportPage> {
  if (!canReadModerationQueue(actor.role)) {
    throw AppError.authorization("You do not have permission to review reports");
  }

  const { skip, take } = toPrismaOffset({ page: query.page, limit: query.limit });

  const { rows, total } = await repo.listReports(
    {
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.targetType !== undefined ? { targetType: query.targetType } : {}),
    },
    { skip, take },
  );

  return {
    reports: rows.map(toReportDetailView),
    pagination: buildPagination({ page: query.page, limit: query.limit }, total),
  };
}

export async function getReport(
  actor: Actor,
  reportId: string,
): Promise<ReportDetailView> {
  if (!canReadReport(actor.role)) {
    throw AppError.authorization("You do not have permission to review reports");
  }

  const row = await repo.findReportById(reportId);
  if (row === null) {
    throw AppError.notFound("Report not found");
  }

  return toReportDetailView(row);
}

/* ── Reports: review ─────────────────────────────────────────────────────── */

function auditActionForStatus(status: UpdateReportBody["status"]): AuditActionValue {
  switch (status) {
    case "reviewing":
      return AuditAction.REPORT_REVIEWED;
    case "resolved":
      return AuditAction.REPORT_RESOLVED;
    case "dismissed":
      return AuditAction.REPORT_DISMISSED;
    case "pending":
      // Unreachable: no transition leads back to `pending`, and the guard
      // below rejects it before this is called. Named so the switch stays
      // exhaustive rather than needing a `default` that could hide a new state.
      return AuditAction.REPORT_REVIEWED;
  }
}

/**
 * Moves a report through its lifecycle.
 *
 *     pending ──► reviewing ──► resolved
 *                          └──► dismissed
 *
 * An illegal transition is a **409**, not a 422: the value is well-formed and
 * would be legal from another state, so it is a conflict with the resource's
 * current condition rather than a malformed request. That includes closing a
 * report that is already closed, and skipping `reviewing` on the way to
 * `resolved`.
 *
 * The transition is applied with the observed status in the `where` clause, so
 * two moderators claiming the same pending report race in the database and
 * exactly one wins. The loser gets the same 409 as an illegal transition,
 * which is the truthful answer: by the time their write landed, the report was
 * no longer in the state they acted on.
 */
export async function reviewReport(
  actor: Actor,
  reportId: string,
  body: UpdateReportBody,
  audit: AuditContext,
): Promise<ReportDetailView> {
  if (!canReadReport(actor.role)) {
    throw AppError.authorization("You do not have permission to review reports");
  }

  const existing = await repo.findReportById(reportId);
  if (existing === null) {
    throw AppError.notFound("Report not found");
  }

  if (!canTransitionReport(existing.status, body.status)) {
    throw AppError.conflict(
      `A report that is ${existing.status} cannot be moved to ${body.status}`,
    );
  }

  const updated = await repo.updateReportStatus({
    reportId,
    status: body.status,
    reviewerId: actor.id,
    resolution: body.resolution ?? null,
    resolvedAt: closesReport(body.status) ? new Date() : null,
    expectedStatus: existing.status,
    auditAction: auditActionForStatus(body.status),
    ipAddress: audit.ipAddress,
    userAgent: audit.userAgent,
  });

  if (updated === null) {
    // The status moved between the read above and the guarded write — another
    // moderator got there first.
    throw AppError.conflict("That report was updated by someone else");
  }

  return toReportDetailView(updated);
}

/* ── Moderation actions ──────────────────────────────────────────────────── */

function auditActionForModeration(action: ModerationActionType): AuditActionValue {
  switch (action) {
    case "warning":
      return AuditAction.USER_WARNED;
    case "suspension":
      return AuditAction.USER_SUSPENDED;
    case "ban":
      return AuditAction.USER_BANNED;
    case "shadow_ban":
      return AuditAction.USER_SHADOW_BANNED;
    case "unban":
      return AuditAction.USER_UNBANNED;
    case "reinstate":
      return AuditAction.USER_REINSTATED;
    case "content_removal":
      // Refined by the caller, which knows which kind of content it was.
      return AuditAction.POST_REMOVED;
  }
}

/**
 * The audit verb for a removal, which ARCHITECTURE §26 names per content type
 * (`POST_REMOVED`) rather than generically.
 */
function auditActionForRemoval(targetType: ReportTargetType): AuditActionValue {
  switch (targetType) {
    case "post":
      return AuditAction.POST_REMOVED;
    case "comment":
      return AuditAction.COMMENT_REMOVED;
    case "project":
      return AuditAction.PROJECT_REMOVED;
    case "community":
      return AuditAction.COMMUNITY_REMOVED;
    case "message":
      return AuditAction.MESSAGE_REMOVED;
    case "user":
      // Refused earlier: `content_removal` never targets an account.
      return AuditAction.POST_REMOVED;
  }
}

/** A short phrase for the notification the affected user receives. */
function notificationSubject(
  action: ModerationActionType,
  targetType: ReportTargetType,
): string {
  switch (action) {
    case "warning":
      return "a warning was issued";
    case "suspension":
      return "your account was temporarily suspended";
    case "ban":
      return "your account was banned";
    case "content_removal":
      return `your ${targetType} was removed`;
    case "shadow_ban":
    case "unban":
    case "reinstate":
      // `notifiesTarget` excludes these; the branch exists for exhaustiveness.
      return "your account was reviewed";
  }
}

/**
 * Records a moderation action.
 *
 * The order of checks is the order of increasing cost, and every one of them
 * is a refusal a client must not be able to skip:
 *
 *   1. **Verb and target agree.** Account verbs take a `user` target; content
 *      removal takes anything but. A caller cannot "ban" a post or "remove"
 *      an account.
 *   2. **Expiry matches the verb.** Only a suspension carries one, and every
 *      suspension must — a suspension with no expiry is a ban wearing the
 *      wrong name, and the schema documents `expiresAt: null` as permanent.
 *   3. **The target exists.** 404 otherwise.
 *   4. **Rank permits it** (`canActOnUser`). This is the privilege boundary:
 *      a moderator cannot action a peer or a superior, and nobody actions
 *      themselves. 403.
 *   5. **A named report exists**, if one was named.
 *
 * Only then does the transactional write run. The notification is raised
 * *after* it commits, through the port, and cannot fail the action — the port
 * contract has been fire-and-forget since Phase 4 and stays that way here.
 */
export async function createAction(
  actor: Actor,
  body: CreateActionBody,
  audit: AuditContext,
): Promise<ModerationActionResultView> {
  const removesContent = targetsContent(body.action);

  if (removesContent && body.targetType === "user") {
    throw AppError.badRequest("Content removal cannot target an account");
  }
  if (!removesContent && body.targetType !== "user") {
    throw AppError.badRequest(`A ${body.action} action must target a user`);
  }

  if (requiresExpiry(body.action) && body.expiresAt === undefined) {
    throw AppError.badRequest("A temporary suspension requires an expiry");
  }
  if (!allowsExpiry(body.action) && body.expiresAt !== undefined) {
    throw AppError.badRequest(`A ${body.action} action cannot carry an expiry`);
  }
  if (body.expiresAt !== undefined && body.expiresAt.getTime() <= Date.now()) {
    throw AppError.badRequest("A suspension must expire in the future");
  }

  const target = await repo.resolveTarget(body.targetType, body.targetId);
  if (!target.exists) {
    throw AppError.notFound("That content could not be found");
  }

  // For an account verb this is the target itself; for a removal it is whoever
  // authored the content. Either way it is resolved server-side.
  const targetUserId = target.authorId;
  if (targetUserId === null) {
    throw AppError.notFound("That content could not be found");
  }

  const targetUser = await repo.findUserForModeration(targetUserId);
  if (targetUser === null) {
    throw AppError.notFound("That account could not be found");
  }

  const decision = canActOnUser({
    actorId: actor.id,
    actorRole: actor.role,
    targetUserId: targetUser.id,
    targetUserRole: targetUser.role,
  });

  if (!decision.allowed) {
    // One message for all three refusals. Distinguishing "you outrank nobody"
    // from "that account outranks you" would turn the endpoint into a probe
    // for other users' roles.
    throw AppError.authorization("You do not have permission to moderate this account");
  }

  if (body.reportId !== undefined) {
    const report = await repo.findReportById(body.reportId);
    if (report === null) {
      throw AppError.notFound("Report not found");
    }
  }

  const result = await repo.recordModerationAction({
    moderatorId: actor.id,
    action: body.action,
    targetType: body.targetType,
    targetId: body.targetId,
    targetUserId,
    nextStatus: statusAfterAction(body.action),
    reason: body.reason,
    expiresAt: body.expiresAt ?? null,
    reportId: body.reportId ?? null,
    parentPostId: target.parentPostId,
    auditAction: removesContent
      ? auditActionForRemoval(body.targetType)
      : auditActionForModeration(body.action),
    ipAddress: audit.ipAddress,
    userAgent: audit.userAgent,
  });

  await notifyTarget(body.action, body.targetType, body.targetId, targetUserId);

  return toActionResultView(result);
}

/* ── Status changes, shared with the admin module ────────────────────────── */

/**
 * Sets an account's moderation standing.
 *
 * This exists so `PATCH /admin/users/:id/status` does not need a second way to
 * write `User.status`. The admin route speaks in *states* because that is what
 * the shipped UI sends; this translates the state into the moderation verb
 * that gets recorded, then takes the identical path `POST /moderation/actions`
 * takes — same rank check, same transaction, same audit row, same
 * notification. Ruling R9 holds because there is exactly one writer.
 *
 * Refuses with 409 when the account already holds the requested status: a
 * moderation action that changed nothing is noise in a trail whose value comes
 * from every row meaning something.
 */
export async function applyStatusChange(
  actor: Actor,
  targetUserId: string,
  nextStatus: ModerationStatus,
  reason: string,
  audit: AuditContext,
): Promise<ModerationActionResultView> {
  const targetUser = await repo.findUserForModeration(targetUserId);
  if (targetUser === null) {
    throw AppError.notFound("That account could not be found");
  }

  const decision = canActOnUser({
    actorId: actor.id,
    actorRole: actor.role,
    targetUserId: targetUser.id,
    targetUserRole: targetUser.role,
  });

  if (!decision.allowed) {
    throw AppError.authorization("You do not have permission to moderate this account");
  }

  const action = actionForStatusChange(targetUser.status, nextStatus);
  if (action === null) {
    throw AppError.conflict(`That account is already ${nextStatus}`);
  }

  const result = await repo.recordModerationAction({
    moderatorId: actor.id,
    action,
    targetType: "user",
    targetId: targetUserId,
    targetUserId,
    nextStatus,
    reason,
    // A status change through the admin table is never timed; a temporary
    // suspension is filed as its own verb through `POST /moderation/actions`.
    expiresAt: null,
    reportId: null,
    parentPostId: null,
    auditAction: auditActionForModeration(action),
    ipAddress: audit.ipAddress,
    userAgent: audit.userAgent,
  });

  await notifyTarget(action, "user", targetUserId, targetUserId);

  return toActionResultView(result);
}

/**
 * Tells the affected user what happened (ruling R11).
 *
 * Raised through `notificationPort` — the same seam every domain service has
 * used since Phase 4 — rather than a second delivery mechanism. Two properties
 * are specific to moderation and both are deliberate:
 *
 *   - **No actor.** `actorId` is null, which the schema documents as the
 *     system case (*"Null for system-generated notifications (achievements,
 *     moderation)"*). Naming the moderator would tell a banned user exactly
 *     who to retaliate against, and it is also what makes the notification
 *     immune to the block rule: `resolveDelivery` skips the self and block
 *     checks entirely when there is no actor.
 *   - **Not suppressible by preference.** `notification.access.ts` treats
 *     `moderation` as unsuppressible, so a user who muted the type in settings
 *     is still told their account was banned. A warning nobody receives is not
 *     a warning.
 *
 * Failures are logged and swallowed. The action already committed with its
 * audit record; a notification that could not be delivered must not undo it.
 */
async function notifyTarget(
  action: ModerationActionType,
  targetType: ReportTargetType,
  targetId: string,
  targetUserId: string,
): Promise<void> {
  if (!notifiesTarget(action)) return;

  try {
    await notificationPort.emit({
      recipientId: targetUserId,
      actorId: null,
      type: "moderation",
      entityType: entityTypeForReportTarget(targetType),
      entityId: targetId,
      subject: notificationSubject(action, targetType),
    });
  } catch (error) {
    logger.error(
      { err: error, action, recipientId: targetUserId },
      "Moderation notification failed — the action itself is unaffected",
    );
  }
}
