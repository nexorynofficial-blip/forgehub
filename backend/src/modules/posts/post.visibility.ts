import type { UserRole, Visibility } from "@prisma/client";

import { isAdminRole } from "../../middleware/role.middleware.js";

/**
 * Post visibility rules (PRD §8, decision J9).
 *
 * Pure functions, tested without a database, a session, or an HTTP request —
 * the same discipline as `users/visibility.ts` and
 * `projects/project.visibility.ts`, and for the same reason: these decide
 * whether private content leaves the server, so every branch has to be
 * reachable directly rather than only through an awkwardly staged scenario.
 *
 * Structurally close to the project rules but **not** shared with them. A post
 * has an author and a community; a project has an owner and members. Folding
 * both into one function would mean branching on which kind of subject it was
 * given, which is exactly how privacy logic drifts.
 */

/**
 * `not_found`, never `forbidden`. A 403 confirms the post exists and, in the
 * block case, announces the block — 404 is indistinguishable from a deleted or
 * never-existing post, which is what a blocked or unauthorized viewer sees.
 */
export type PostVisibilityDecision = "full" | "not_found";

export interface PostVisibilityContext {
  viewerId: string | null;
  viewerRole: UserRole | null;
  authorId: string;
  visibility: Visibility;
  /** Soft-deleted posts are gone as far as every read path is concerned. */
  deleted: boolean;
  /** The post's author has blocked the viewer (Phase 4 `Block`). */
  authorBlockedViewer: boolean;
  /**
   * The post was published into a community (decision J9).
   *
   * Community visibility depends on a `Community` that Phase 7 owns, so this
   * phase cannot evaluate it. Rather than guess — and guessing "public" would
   * leak private-community content the moment Phase 7 lands — such posts are
   * excluded from listings and, when read directly, treated as visible only to
   * their author. Phase 7 replaces this with a real community check.
   */
  inCommunity: boolean;
}

/**
 * Direct access to a single post, by id.
 *
 * Rule order is load-bearing:
 *
 *  1. **Soft delete first.** A deleted post is not a privacy question.
 *  2. **Blocking outranks everything, including the admin role**, carrying
 *     forward the Phase 4/5 precedent. Admin moderation tooling is a Phase 11
 *     surface with its own audited endpoints; it should not arrive by accident
 *     through a post read.
 *  3. Author, then admin — the cheapest identity check first.
 *  4. A community post is author-only until Phase 7 can evaluate the community.
 *  5. `unlisted` resolves to `full` **here** and is filtered out of the feed
 *     instead. That split is the whole distinction between `unlisted` and
 *     `private`: unlisted means "not enumerable", not "not readable".
 */
export function resolvePostVisibility(
  context: PostVisibilityContext,
): PostVisibilityDecision {
  if (context.deleted) return "not_found";
  if (context.authorBlockedViewer) return "not_found";

  const isAuthor = context.viewerId !== null && context.viewerId === context.authorId;
  if (isAuthor) return "full";

  // Deliberately before the admin check: an admin cannot stand in for the
  // community membership test this phase is unable to perform.
  if (context.inCommunity) return "not_found";

  if (context.viewerRole !== null && isAdminRole(context.viewerRole)) return "full";

  if (context.visibility === "public") return "full";
  if (context.visibility === "unlisted") return "full";

  return "not_found";
}

/**
 * Whether a post may appear in the feed or any listing.
 *
 * Stricter than direct access in exactly two ways: `unlisted` is omitted, and
 * community posts are omitted for everyone including their author — the feed
 * is a cross-cutting surface, and a post whose audience this phase cannot
 * compute does not belong in it.
 *
 * An author still sees their own `private` posts in their own timeline, which
 * is why `visibility` is not simply required to be `public`.
 */
export function isPostListable(context: PostVisibilityContext): boolean {
  if (context.deleted) return false;
  if (context.authorBlockedViewer) return false;
  if (context.inCommunity) return false;

  if (context.viewerId !== null && context.viewerId === context.authorId) return true;
  if (context.viewerRole !== null && isAdminRole(context.viewerRole)) {
    return context.visibility === "public";
  }

  return context.visibility === "public";
}
