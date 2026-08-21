import type { UserRole, Visibility } from "@prisma/client";

import { isAdminRole } from "../../middleware/role.middleware.js";

/**
 * Project visibility rules (decisions J5 + PRD §6).
 *
 * Pure functions, tested without a database, a session, or an HTTP request —
 * the same discipline as the users module's `visibility.ts`, and for the same
 * reason: these decide whether private data leaves the server, so every branch
 * has to be reachable directly rather than only through an awkwardly staged
 * end-to-end scenario.
 *
 * This is **not** a reuse of `users/visibility.ts`. That one resolves
 * `ProfileVisibility` (`public` | `followers`); this one resolves `Visibility`
 * (`public` | `private` | `unlisted`). Different enums, different rules — a
 * shared function would have to branch on which kind of subject it was given,
 * which is exactly how privacy logic drifts.
 */

/**
 * `not_found`, never `forbidden`. A 403 confirms the project exists and — in
 * the block case — announces the block; a 404 is indistinguishable from a
 * deleted or never-existing project, which is the behaviour a blocked or
 * unauthorized viewer should get.
 */
export type ProjectVisibilityDecision = "full" | "not_found";

export interface ProjectVisibilityContext {
  viewerId: string | null;
  viewerRole: UserRole | null;
  ownerId: string;
  visibility: Visibility;
  /** Soft-deleted projects are gone as far as every read path is concerned. */
  deleted: boolean;
  /** Viewer holds a `ProjectMember` row on this project. */
  isMember: boolean;
  /** The project's owner has blocked the viewer (Phase 4 `Block`). */
  ownerBlockedViewer: boolean;
}

/**
 * Direct access to a single project, by slug.
 *
 * Rule order is load-bearing:
 *
 *  1. **Soft delete first.** A deleted project is not a privacy question.
 *  2. **Blocking outranks everything, including the admin role** (decision J5,
 *     carrying forward the Phase 4 precedent). Admin moderation tooling is a
 *     Phase 11 surface with its own audited endpoints; it should not arrive by
 *     accident through a project read.
 *  3. Owner, then member, then admin — the cheapest identity checks first.
 *  4. `unlisted` resolves to `full` **here** and is filtered out of listings
 *     instead. That split is the entire distinction PRD §6 draws between
 *     `unlisted` and `private`: unlisted means "not enumerable", not
 *     "not readable".
 */
export function resolveProjectVisibility(
  context: ProjectVisibilityContext,
): ProjectVisibilityDecision {
  if (context.deleted) return "not_found";
  if (context.ownerBlockedViewer) return "not_found";

  if (context.viewerId !== null && context.viewerId === context.ownerId) return "full";
  if (context.isMember) return "full";
  if (context.viewerRole !== null && isAdminRole(context.viewerRole)) return "full";

  if (context.visibility === "public") return "full";
  if (context.visibility === "unlisted") return "full";

  return "not_found";
}

/**
 * Whether a project may appear in a *listing* — discovery, trending, or an
 * owner's project grid.
 *
 * Identical to the direct-access rules except that `unlisted` is omitted. A
 * viewer with a privileged relationship to the project (owner, member, admin)
 * still sees it in their own listings, because for them it is not hidden
 * content — it is their content.
 */
export function isProjectListable(context: ProjectVisibilityContext): boolean {
  if (context.deleted) return false;
  if (context.ownerBlockedViewer) return false;

  if (context.viewerId !== null && context.viewerId === context.ownerId) return true;
  if (context.isMember) return true;
  if (context.viewerRole !== null && isAdminRole(context.viewerRole)) return true;

  return context.visibility === "public";
}
