import { EntityType, ModerationStatus, UserRole } from "@prisma/client";
import { z } from "zod";

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../../utils/pagination.js";

/**
 * Request validation for the admin module (TRD §15).
 *
 * The omissions are the security property, exactly as in every module since
 * Phase 5. No schema here declares `actorId`, `moderatorId`, or any other way
 * to name who is performing the operation — the administrator is the token
 * holder, resolved in the controller from a verified access token. Zod strips
 * anything else a client sends.
 *
 * The role and status enums are derived from Prisma's own enum objects rather
 * than hand-written string unions, so a schema change cannot leave a stale
 * copy here accepting a value the database no longer has.
 */

const uuid = z.string().uuid("Must be a valid id");

export const userIdParamSchema = z.object({ id: uuid });
export type UserIdParam = z.infer<typeof userIdParamSchema>;

const USER_ROLES = Object.values(UserRole) as [UserRole, ...UserRole[]];
const MODERATION_STATUSES = Object.values(ModerationStatus) as [
  ModerationStatus,
  ...ModerationStatus[],
];
const ENTITY_TYPES = Object.values(EntityType) as [EntityType, ...EntityType[]];

/* ── Users ───────────────────────────────────────────────────────────────── */

/**
 * The user-table query.
 *
 * Offset pagination — a stable, page-numbered administrative table is the
 * exact case TRD §8 gives offset paging, and the frontend renders it as one.
 *
 * There is deliberately **no free-text search parameter.** PRD §18 asks for
 * "User management" and the shipped `getAdminUsers()` takes no arguments, so a
 * `q` filter would be inferring a requirement rather than meeting one — and
 * building a second user-search surface a phase after Phase 10 ruled how
 * user search works would be the wrong way to add one. The `role` and `status`
 * filters below are here because the table renders both columns and both are
 * indexed enum equality rather than a scan.
 */
export const listUsersQuerySchema = z.object({
  role: z.enum(USER_ROLES).optional(),
  status: z.enum(MODERATION_STATUSES).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

/**
 * The role-change body.
 *
 * `guest` passes the enum here and is refused by `canChangeRole` in the pure
 * layer. That split is deliberate: the value is a real member of the database
 * enum, so rejecting it as *malformed* would be a lie. It is well-formed and
 * not permitted, which is a 403.
 */
export const updateUserRoleSchema = z.object({
  role: z.enum(USER_ROLES),
});

export type UpdateUserRoleBody = z.infer<typeof updateUserRoleSchema>;

/**
 * The status-change body.
 *
 * A state, not a verb — matching the shipped `updateUserStatus(userId,
 * status)`. `moderation.access.actionForStatusChange` translates it into the
 * moderation verb that gets recorded, so this route produces the same
 * `ModerationAction` and `AuditLog` rows that `/moderation/actions` does.
 *
 * `reason` is optional and lands on the recorded action. There is no
 * `expiresAt`: a timed suspension is a moderation verb with its own
 * requirements, and it is filed through `POST /moderation/actions`. This route
 * sets standing, permanently, until someone changes it back.
 */
export const updateUserStatusSchema = z.object({
  status: z.enum(MODERATION_STATUSES),
  reason: z.string().max(1000).trim().default(""),
});

export type UpdateUserStatusBody = z.infer<typeof updateUserStatusSchema>;

/* ── Audit logs ──────────────────────────────────────────────────────────── */

/**
 * The audit-log query.
 *
 * Every filter is an exact match on an indexed column —
 * `audit_logs(actorId, createdAt)`, `(action, createdAt)`, and
 * `(targetType, targetId)` are all present in the schema. `action` is a free
 * string because the column is (the schema keeps it free-form *"so new audited
 * actions need no migration"*), bounded in length so a filter cannot become a
 * pathological scan.
 */
export const listAuditLogsQuerySchema = z.object({
  actorId: uuid.optional(),
  action: z.string().min(1).max(64).optional(),
  targetType: z.enum(ENTITY_TYPES).optional(),
  targetId: uuid.optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuerySchema>;
