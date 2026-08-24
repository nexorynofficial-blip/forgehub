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
   * The post was published into a community.
   *
   * **Phase 7 seam.** Under Phase 6 decision J9 this was a bare boolean and any
   * `true` meant "author only", because no `Community` existed to evaluate.
   * Phase 7 supplies the community's actual standing instead: `null` for a post
   * that belongs to no community, or the resolved access decision for one that
   * does (decision J2).
   *
   * Resolved by the caller rather than here, because it depends on a membership
   * lookup this pure function must not perform — `canAccessCommunityPost` in
   * `communities/community.visibility.ts` is where that rule lives, and it is
   * unit-tested there alongside the rest of the community matrix.
   */
  community: CommunityStanding | null;
}

/**
 * What the viewer may do with the community a post lives in.
 *
 *   - `readable` — the community permits this viewer to read its posts. The
 *     post's own visibility still applies on top.
 *   - `hidden` — a private community the viewer does not belong to, or a
 *     soft-deleted one. Resolves to 404, and **not even the author gets in**
 *     when the community is deleted (decision J13).
 *   - `listable` — additionally public, so the post may appear in the global
 *     feed. Only ever produced for public, live communities.
 */
export type CommunityStanding = "readable" | "hidden" | "listable";

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
 *  3. **The community gate, before the post's own visibility** (Phase 7,
 *     decision J2). A `public` post inside a `private` community is private;
 *     reversing the order would expose the whole contents of every private
 *     community, since posts default to `public`.
 *  4. Author, then admin.
 *  5. `unlisted` resolves to `full` **here** and is filtered out of the feed
 *     instead. That split is the whole distinction between `unlisted` and
 *     `private`: unlisted means "not enumerable", not "not readable".
 */
export function resolvePostVisibility(
  context: PostVisibilityContext,
): PostVisibilityDecision {
  if (context.deleted) return "not_found";
  if (context.authorBlockedViewer) return "not_found";

  // Before the author check, not after: a soft-deleted community takes its
  // posts with it for everyone, their authors included (decision J13). The
  // caller resolves `hidden` for that case as well as for a private community
  // the viewer does not belong to.
  if (context.community === "hidden") return "not_found";

  const isAuthor = context.viewerId !== null && context.viewerId === context.authorId;
  if (isAuthor) return "full";

  if (context.viewerRole !== null && isAdminRole(context.viewerRole)) return "full";

  if (context.visibility === "public") return "full";
  if (context.visibility === "unlisted") return "full";

  return "not_found";
}

/**
 * Whether a post may appear in the feed or any listing.
 *
 * Stricter than direct access in exactly two ways: `unlisted` is omitted, and a
 * community post must be `listable` — that is, in a public, live community
 * (Phase 7, decision J2). A member of a *private* community reads its posts on
 * the community page, which owns its own scoped listing; letting them surface
 * here would push private-community content into `following`, `trending`, and
 * every other cross-cutting filter.
 *
 * An author still sees their own `private` posts in their own timeline, which
 * is why `visibility` is not simply required to be `public`.
 */
export function isPostListable(context: PostVisibilityContext): boolean {
  if (context.deleted) return false;
  if (context.authorBlockedViewer) return false;
  if (context.community !== null && context.community !== "listable") return false;

  if (context.viewerId !== null && context.viewerId === context.authorId) return true;
  if (context.viewerRole !== null && isAdminRole(context.viewerRole)) {
    return context.visibility === "public";
  }

  return context.visibility === "public";
}
