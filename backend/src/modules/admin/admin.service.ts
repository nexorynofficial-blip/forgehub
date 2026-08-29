import type { UserRole } from "@prisma/client";

import { listAuditLogs as listAuditLogRows } from "../../repositories/audit.repository.js";
import { AuditAction, type AuditContext } from "../../utils/audit.js";
import { AppError } from "../../utils/errors.js";
import { buildPagination, toPrismaOffset } from "../../utils/pagination.js";
import type { Pagination } from "../../utils/response.js";
import { canChangeRole } from "../moderation/moderation.access.js";
import * as moderationRepo from "../moderation/moderation.repository.js";
import * as moderation from "../moderation/moderation.service.js";
import type { ModerationActionResultView } from "../moderation/moderation.types.js";
import {
  canReadAdminSurface,
  canReadAuditLogs,
  signupWeekBuckets,
} from "./admin.access.js";
import * as repo from "./admin.repository.js";
import type {
  ListAuditLogsQuery,
  ListUsersQuery,
  UpdateUserRoleBody,
  UpdateUserStatusBody,
} from "./admin.schema.js";
import type {
  AdminOverviewStatsView,
  AdminUserSummaryView,
  AuditLogView,
  ReportsByReasonView,
  WeeklySignupView,
} from "./admin.types.js";
import {
  toAdminUserSummary,
  toAuditLogView,
  toReportsByReason,
  toWeeklySignups,
} from "./admin.view.js";

/**
 * Administration business logic (PRD §18, TRD §29, ARCHITECTURE §26).
 *
 * PRD §18 lists seven administrator capabilities. This module serves four of
 * them directly — User management, Reports (counts), Analytics, Audit logs —
 * and reaches the other three through the moderation module rather than
 * duplicating them: "Content moderation" is `POST /moderation/actions`, and
 * "Community management" and "Project management" have no endpoint contract in
 * the shipped frontend and are deliberately out of scope for this phase.
 *
 * The dependency arrow runs **admin → moderation** and never back. Every
 * mutation that changes a user's standing is delegated to
 * `moderation.service.applyStatusChange`, so there is exactly one code path
 * that writes `User.status` and it is the one that writes the audit row in the
 * same transaction (ruling R9).
 *
 * Two rules carried from every prior phase:
 *
 *   1. **Identity comes from the caller** — the actor below is built by the
 *      controller from the verified access token.
 *   2. **Projection happens last**, in `admin.view.ts`.
 */

export interface Actor {
  id: string;
  role: UserRole;
}

function assertCanRead(actor: Actor): void {
  if (!canReadAdminSurface(actor.role)) {
    throw AppError.authorization("You do not have permission to access this resource");
  }
}

/* ── Users ───────────────────────────────────────────────────────────────── */

export interface AdminUserPage {
  users: AdminUserSummaryView[];
  pagination: Pagination;
}

export async function listUsers(
  actor: Actor,
  query: ListUsersQuery,
): Promise<AdminUserPage> {
  assertCanRead(actor);

  const { skip, take } = toPrismaOffset({ page: query.page, limit: query.limit });

  const { rows, total } = await repo.listUsers(
    {
      ...(query.role !== undefined ? { role: query.role } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
    },
    { skip, take },
  );

  return {
    users: rows.map(toAdminUserSummary),
    pagination: buildPagination({ page: query.page, limit: query.limit }, total),
  };
}

/**
 * Changes a user's role (ruling R4).
 *
 * The most privileged write in the API, and the checks reflect it:
 *
 *   - The route is `requirePlatformAdmin`, so a moderator or community admin
 *     never reaches this function.
 *   - `canChangeRole` re-asserts that independently of the route, refuses a
 *     self-change, refuses assigning `guest`, and refuses acting on an account
 *     that outranks or equals the actor — which means no platform admin can
 *     demote or promote another platform admin.
 *   - The write is guarded on the role the caller observed, so two
 *     simultaneous changes cannot silently overwrite one another.
 *
 * Note what is *not* consulted: anything in the request body except the target
 * role. The actor is the token holder and the target is the path parameter.
 */
export async function updateUserRole(
  actor: Actor,
  targetUserId: string,
  body: UpdateUserRoleBody,
  audit: AuditContext,
): Promise<AdminUserSummaryView> {
  const target = await repo.findUserById(targetUserId);
  if (target === null) {
    throw AppError.notFound("That account could not be found");
  }

  const decision = canChangeRole({
    actorId: actor.id,
    actorRole: actor.role,
    targetUserId: target.id,
    targetUserRole: target.role,
    nextRole: body.role,
  });

  if (!decision.allowed) {
    // One message for every refusal. Distinguishing "you may not grant that"
    // from "that account outranks you" would let a caller map other users'
    // roles by probing.
    throw AppError.authorization("You do not have permission to change this role");
  }

  if (target.role === body.role) {
    throw AppError.conflict(`That account already holds the ${body.role} role`);
  }

  const updated = await repo.updateUserRole({
    userId: targetUserId,
    nextRole: body.role,
    actorId: actor.id,
    expectedRole: target.role,
    auditAction: AuditAction.ROLE_CHANGED,
    ipAddress: audit.ipAddress,
    userAgent: audit.userAgent,
  });

  if (updated === null) {
    throw AppError.conflict("That account was updated by someone else");
  }

  return toAdminUserSummary(updated);
}

/**
 * Changes a user's moderation standing.
 *
 * Delegates entirely to the moderation module, which performs the rank check,
 * the transactional write, the audit row, and the notification. This function
 * exists to give the admin table the route it already calls
 * (`updateUserStatus`) without giving the codebase a second way to ban
 * someone.
 */
export async function updateUserStatus(
  actor: Actor,
  targetUserId: string,
  body: UpdateUserStatusBody,
  audit: AuditContext,
): Promise<ModerationActionResultView> {
  return moderation.applyStatusChange(
    { id: actor.id, role: actor.role },
    targetUserId,
    body.status,
    body.reason,
    audit,
  );
}

/* ── Analytics (ruling R15) ──────────────────────────────────────────────── */

export async function getOverviewStats(actor: Actor): Promise<AdminOverviewStatsView> {
  assertCanRead(actor);
  return repo.countOverview();
}

/**
 * Weekly signups for the growth chart.
 *
 * `now` is a parameter so the tests can pin the bucket boundaries instead of
 * racing the clock; every caller in production passes the current time.
 */
export async function getWeeklySignups(
  actor: Actor,
  now: Date = new Date(),
): Promise<WeeklySignupView[]> {
  assertCanRead(actor);

  const buckets = signupWeekBuckets(now);
  const counts = await repo.countSignupsByWeek(buckets);

  return toWeeklySignups(buckets, counts);
}

export async function getReportsByReason(actor: Actor): Promise<ReportsByReasonView[]> {
  assertCanRead(actor);

  const rows = await moderationRepo.countReportsByReason();
  return toReportsByReason(rows);
}

/* ── Audit logs (ruling R5) ──────────────────────────────────────────────── */

export interface AuditLogPage {
  logs: AuditLogView[];
  pagination: Pagination;
}

/**
 * Reads the audit trail.
 *
 * `platform_admin` only, and the check is here rather than only on the route
 * for the usual reason: a route guard is one edit away from being deleted, and
 * this is the layer the unit and security tests pin. A moderator reaching this
 * function gets the same 403 the middleware would have given them.
 *
 * There is no write path. `audit.repository.ts` exposes an insert and two
 * reads and nothing else — the table is append-only by design (TRD §29), so
 * "audit logs must not be editable by normal users" is enforced by there being
 * no editor at all, for any user.
 */
export async function listAuditLogs(
  actor: Actor,
  query: ListAuditLogsQuery,
): Promise<AuditLogPage> {
  if (!canReadAuditLogs(actor.role)) {
    throw AppError.authorization("You do not have permission to read audit logs");
  }

  const { skip, take } = toPrismaOffset({ page: query.page, limit: query.limit });

  const { rows, total } = await listAuditLogRows(
    {
      ...(query.actorId !== undefined ? { actorId: query.actorId } : {}),
      ...(query.action !== undefined ? { action: query.action } : {}),
      ...(query.targetType !== undefined ? { targetType: query.targetType } : {}),
      ...(query.targetId !== undefined ? { targetId: query.targetId } : {}),
    },
    { skip, take },
  );

  return {
    logs: rows.map(toAuditLogView),
    pagination: buildPagination({ page: query.page, limit: query.limit }, total),
  };
}
