import type { UserRole } from "@prisma/client";
import type { Request, RequestHandler } from "express";

import { AppError } from "../utils/errors.js";

/**
 * Role-based authorization (BACKEND_ARCHITECTURE.md §18).
 *
 * Roles are the six the frontend ships and Phase 2 migrated
 * (`src/types/common.ts`, `src/lib/rbac.ts`) — not BACKEND_TRD.md §14's
 * `USER/MODERATOR/ADMIN/SUPER_ADMIN`, which would contradict the authorization
 * code already running in `AppSidebar` and `AdminGuard`.
 */

/**
 * Mirrors the frontend's `isAdminRole` exactly. Kept in sync deliberately:
 * if the server allowed a role the sidebar hides, a user would see 403s from
 * links they were shown — and the reverse would be a privilege gap.
 */
const ADMIN_ROLES: readonly UserRole[] = [
  "moderator",
  "community_admin",
  "platform_admin",
];

/**
 * `guest` exists in the enum because the frontend uses it to mean "not signed
 * in". It is never written to the database (see `auth.repository.createUser`)
 * and must never satisfy an authorization check.
 */
function isAuthorizedRole(role: UserRole, allowed: readonly UserRole[]): boolean {
  if (role === "guest") return false;
  return allowed.includes(role);
}

/** Requires one of the listed roles. Must run after `requireAuth`. */
export function requireRole(...allowed: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) {
      next(AppError.authentication("Authentication required"));
      return;
    }

    if (!isAuthorizedRole(req.user.role, allowed)) {
      next(AppError.authorization("You do not have permission to perform this action"));
      return;
    }

    next();
  };
}

/** Moderator, community admin, or platform admin. */
export const requireAdmin: RequestHandler = requireRole(...ADMIN_ROLES);

/** Platform admin only — for destructive, instance-wide operations. */
export const requirePlatformAdmin: RequestHandler = requireRole("platform_admin");

export function isAdminRole(role: UserRole): boolean {
  return isAuthorizedRole(role, ADMIN_ROLES);
}

/**
 * Resource ownership (ARCHITECTURE §18's "is Project 123 owned by User A?").
 *
 * Exposed as a plain assertion rather than middleware because ownership
 * usually cannot be decided from the request alone — the service has to load
 * the resource first. Admins bypass, which is the point of having them.
 */
export function assertOwnershipOrAdmin(
  req: Request,
  ownerId: string,
  message = "You do not have permission to modify this resource",
): void {
  if (!req.user) {
    throw AppError.authentication("Authentication required");
  }

  if (req.user.id === ownerId) return;
  if (isAdminRole(req.user.role)) return;

  throw AppError.authorization(message);
}
