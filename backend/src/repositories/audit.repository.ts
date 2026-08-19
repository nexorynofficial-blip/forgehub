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

export async function insertAuditLog(input: AuditLogInput): Promise<void> {
  await prisma.auditLog.create({
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
