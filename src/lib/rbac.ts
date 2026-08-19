import type { UserRole } from "@/types";

/** TRD.md §7 "RBAC (Role-Based Access Control)". Originally local to
 * `AppSidebar` (Phase 04, gating the Admin nav link) — extracted here in
 * Phase 11 so `AdminGuard`'s route-level check can't drift from the nav's
 * visibility check. See docs/ASSUMPTIONS.md (Phase 11). */
const ADMIN_ROLES = new Set<UserRole>(["moderator", "community_admin", "platform_admin"]);

export function isAdminRole(role: UserRole): boolean {
  return ADMIN_ROLES.has(role);
}
