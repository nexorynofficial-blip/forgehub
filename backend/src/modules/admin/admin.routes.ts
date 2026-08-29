import { Router } from "express";

import { requireAuth } from "../../middleware/auth.middleware.js";
import { requireAdmin, requirePlatformAdmin } from "../../middleware/role.middleware.js";
import { validate } from "../../middleware/validation.middleware.js";
import * as controller from "./admin.controller.js";
import {
  listAuditLogsQuerySchema,
  listUsersQuerySchema,
  updateUserRoleSchema,
  updateUserStatusSchema,
  userIdParamSchema,
} from "./admin.schema.js";

/**
 * Administration endpoints, mounted at `/api/v1/admin`
 * (ARCHITECTURE §29, PRD §18).
 *
 * ## Two authorization tiers, and why they differ
 *
 * `requireAdmin` — moderator, community admin, or platform admin — covers the
 * user table, the three analytics endpoints, and status changes. These match
 * what the shipped `AdminGuard` already admits all three staff roles to.
 *
 * `requirePlatformAdmin` covers exactly two routes, and each is a deliberate
 * narrowing of what the frontend allows:
 *
 *   - **`PATCH /users/:id/role`** (ruling R4). The shipped `user-row.tsx`
 *     renders a role `<Select>` containing `platform_admin` to anyone who
 *     reaches the page, and its `updateUserRole` mock has no guard at all. If
 *     the backend mirrored that with `requireAdmin`, any moderator could
 *     promote themselves to platform admin — a privilege-escalation hole. The
 *     server refuses; the frontend's control simply 403s for non-platform
 *     admins, which is the correct direction for the two to disagree in.
 *   - **`GET /audit-logs`** (ruling R5). The trail carries every login, IP
 *     address, and user agent on the platform. TRD §29 requires it not be
 *     editable by normal users; this goes further and restricts *reading* to
 *     the one role that needs it.
 *
 * Both middlewares were written in Phase 3 and, until now, were mounted on no
 * route at all — `tests/auth-security.test.ts` exercised them against a
 * throwaway router. This is their first production use.
 *
 * Note the ordering: `requireAuth` always precedes the role guard, so an
 * anonymous caller gets 401 and an authenticated-but-unauthorized one gets
 * 403. Reversing them would answer "who are you?" with "you may not", which
 * ARCHITECTURE §18 warns against conflating.
 *
 * A factory rather than a module-level router, for consistency with every
 * feature router since Phase 3.
 */
export function createAdminRouter(): Router {
  const router = Router();

  /* ── User management (PRD §18) ─────────────────────────────────────────── */

  router.get(
    "/users",
    requireAuth,
    requireAdmin,
    validate({ query: listUsersQuerySchema }),
    controller.listUsers,
  );

  router.patch(
    "/users/:id/role",
    requireAuth,
    requirePlatformAdmin,
    validate({ params: userIdParamSchema, body: updateUserRoleSchema }),
    controller.updateUserRole,
  );

  router.patch(
    "/users/:id/status",
    requireAuth,
    requireAdmin,
    validate({ params: userIdParamSchema, body: updateUserStatusSchema }),
    controller.updateUserStatus,
  );

  /* ── Analytics (ruling R15) ────────────────────────────────────────────── */

  // `/analytics/*` is declared before nothing that could shadow it — there is
  // no `/:id` route on this router at all, which is deliberate: an admin
  // surface with a wildcard segment is one typo away from matching a literal.
  router.get("/stats", requireAuth, requireAdmin, controller.getStats);

  router.get("/analytics/signups", requireAuth, requireAdmin, controller.getSignups);

  router.get(
    "/analytics/reports-by-reason",
    requireAuth,
    requireAdmin,
    controller.getReportsByReason,
  );

  /* ── Audit logs (ruling R5) ────────────────────────────────────────────── */

  router.get(
    "/audit-logs",
    requireAuth,
    requirePlatformAdmin,
    validate({ query: listAuditLogsQuerySchema }),
    controller.listAuditLogs,
  );

  return router;
}
