import type { EntityType, Prisma } from "@prisma/client";

import { prisma } from "../database/prisma.js";

/**
 * Data access for `audit_logs`.
 *
 * Lives in `src/repositories/` rather than inside a feature module
 * (BACKEND_TRD.md §3 sanctions the directory) because auditing is
 * cross-cutting — auth, moderation, and admin all write here, and none of
 * them should own the others' data layer.
 *
 * The table is append-only by design (TRD §29): no update or delete method
 * exists here, and none should be added.
 *
 * ## Phase 11 additions
 *
 * Two, both minimal and both required by a ruling:
 *
 *   - `insertAuditLog` takes an **optional transaction client**. Phase 3–7
 *     callers pass nothing and keep the fire-and-forget behaviour they were
 *     written for. Moderation passes its own `tx` so the audit row commits or
 *     rolls back *with* the mutation it describes — TRD §28 requires the
 *     record, and a best-effort write could let the action land without it.
 *     The same `client: Prisma.TransactionClient = prisma` shape
 *     `messages.repository.ts` already uses.
 *   - Read methods, because PRD §18 lists "Audit logs" as an administrator
 *     capability. Reads only. There is still no update and no delete.
 */

export interface AuditLogInput {
  actorId: string | null;
  action: string;
  targetType: EntityType | null;
  targetId: string | null;
  metadata: Prisma.InputJsonValue | null;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Appends one audit row.
 *
 * Pass `client` to enlist the insert in a caller's transaction. Omitting it
 * writes through the shared client, which is what every Phase 3–7 call site
 * does and what `utils/audit.recordAuditEvent` continues to do.
 */
export async function insertAuditLog(
  input: AuditLogInput,
  client: Prisma.TransactionClient = prisma,
): Promise<void> {
  await client.auditLog.create({
    data: {
      actorId: input.actorId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      // Prisma distinguishes SQL NULL from JSON null; `Prisma.DbNull` is the
      // former, which is what an absent metadata payload means.
      ...(input.metadata === null ? {} : { metadata: input.metadata }),
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
  });
}

/* ── Reads (Phase 11) ────────────────────────────────────────────────────── */

/**
 * The audit-log projection.
 *
 * `metadata` is included because it is the detail that makes a row useful to a
 * reviewer, and `utils/audit.ts` already forbids credentials from reaching it.
 * The actor is summarised to four fields — never `email`, `role`, or `status`,
 * which is the same actor shape `notification.view.ts` settled on.
 */
const auditLogSelect = {
  id: true,
  actorId: true,
  action: true,
  targetType: true,
  targetId: true,
  metadata: true,
  ipAddress: true,
  userAgent: true,
  createdAt: true,
  actor: {
    select: { id: true, username: true, displayName: true },
  },
} satisfies Prisma.AuditLogSelect;

export type AuditLogRow = Prisma.AuditLogGetPayload<{ select: typeof auditLogSelect }>;

export interface AuditLogFilter {
  actorId?: string;
  action?: string;
  targetType?: EntityType;
  targetId?: string;
}

function auditLogWhere(filter: AuditLogFilter): Prisma.AuditLogWhereInput {
  return {
    ...(filter.actorId !== undefined ? { actorId: filter.actorId } : {}),
    ...(filter.action !== undefined ? { action: filter.action } : {}),
    ...(filter.targetType !== undefined ? { targetType: filter.targetType } : {}),
    ...(filter.targetId !== undefined ? { targetId: filter.targetId } : {}),
  };
}

/**
 * A page of audit rows, newest first.
 *
 * `id` breaks the `createdAt` tie so offset paging is total-ordered — two rows
 * written in the same millisecond (a moderation action and its own audit
 * record frequently are) must not straddle a page boundary. The page and the
 * count share one `where` object so a total can never describe a wider set
 * than the rows, which is the discipline Phase 10 established.
 */
export async function listAuditLogs(
  filter: AuditLogFilter,
  page: { skip: number; take: number },
): Promise<{ rows: AuditLogRow[]; total: number }> {
  const where = auditLogWhere(filter);

  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      select: auditLogSelect,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: page.skip,
      take: page.take,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return { rows, total };
}
