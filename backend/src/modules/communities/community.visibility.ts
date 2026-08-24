import type { UserRole, Visibility } from "@prisma/client";

import { isAdminRole } from "../../middleware/role.middleware.js";

/**
 * Community visibility rules (decisions J2 + J5, PRD §6, ARCHITECTURE §12).
 *
 * Pure functions, tested without a database, a session, or an HTTP request —
 * the same discipline as `project.visibility.ts` and `post.visibility.ts`, and
 * for the same reason: these decide whether private data leaves the server, so
 * every branch has to be reachable directly rather than only through an
 * awkwardly staged end-to-end scenario.
 *
 * This is deliberately **not** a reuse of `project.visibility.ts`, despite
 * resolving the same `Visibility` enum. A project grants access through
 * ownership *or* membership; a community additionally has to answer a question
 * projects never ask — whether a viewer may *join*, and whether a post
 * published *into* it is visible. Folding the two together would mean
 * branching on which kind of subject was passed, which is exactly how privacy
 * logic drifts.
 */

/**
 * `not_found`, never `forbidden`. A 403 confirms the community exists and — in
 * the block case — announces the block; a 404 is indistinguishable from a
 * deleted or never-existing community, which is the behaviour a blocked or
 * unauthorized viewer should get.
 */
export type CommunityVisibilityDecision = "full" | "not_found";

export interface CommunityVisibilityContext {
  viewerId: string | null;
  viewerRole: UserRole | null;
  ownerId: string;
  visibility: Visibility;
  /** Soft-deleted communities are gone as far as every read path is concerned. */
  deleted: boolean;
  /** Viewer holds a `CommunityMember` row on this community. */
  isMember: boolean;
  /** The community's owner has blocked the viewer (Phase 4 `Block`). */
  ownerBlockedViewer: boolean;
}

/**
 * Direct access to a single community, by slug.
 *
 * Rule order is load-bearing:
 *
 *  1. **Soft delete first.** A deleted community is not a privacy question.
 *  2. **Blocking outranks everything, including the admin role and
 *     membership** (decision J2, carrying forward the Phase 4/5/6 precedent).
 *     Admin moderation tooling is a Phase 11 surface with its own audited
 *     endpoints; it should not arrive by accident through a community read.
 *  3. Owner, then member, then admin — the cheapest identity checks first.
 *  4. `unlisted` resolves to `full` **here** and is filtered out of listings
 *     instead. That split is the entire distinction PRD §6 draws between
 *     `unlisted` and `private`: unlisted means "not enumerable", not
 *     "not readable". It is also what makes J5's "self-join by slug" coherent —
 *     you can reach an unlisted community if you were given its address.
 */
export function resolveCommunityVisibility(
  context: CommunityVisibilityContext,
): CommunityVisibilityDecision {
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
 * Whether a community may appear in a *listing* — the discovery grid, a
 * category tab, or a user's community list.
 *
 * Identical to the direct-access rules except that `unlisted` is omitted. A
 * viewer with a privileged relationship (owner, member, admin) still sees it in
 * their own listings, because for them it is not hidden content — it is their
 * community.
 */
export function isCommunityListable(context: CommunityVisibilityContext): boolean {
  if (context.deleted) return false;
  if (context.ownerBlockedViewer) return false;

  if (context.viewerId !== null && context.viewerId === context.ownerId) return true;
  if (context.isMember) return true;
  if (context.viewerRole !== null && isAdminRole(context.viewerRole)) return true;

  return context.visibility === "public";
}

/* ── Community posts (decision J2) ───────────────────────────────────────── */

/**
 * Whether a post published into a community is readable, given the community's
 * own visibility and the viewer's standing in it.
 *
 * This is the function that finally retires Phase 6's placeholder. Phase 6
 * could not evaluate a community that did not exist, so decision J9 made every
 * post carrying a `communityId` author-only and absent from every listing. The
 * rules below replace that with the real test.
 *
 * The community gate runs **before** the post's own visibility, not after:
 * a `public` post inside a `private` community is private. Reversing the order
 * would leak the entire contents of every private community, since almost
 * every post is `public` by default.
 *
 * Returned as a boolean rather than a decision string because the caller
 * combines it with `resolvePostVisibility`; the 404-not-403 choice is made
 * there, once, for both halves.
 */
export interface CommunityPostAccessContext {
  viewerId: string | null;
  viewerRole: UserRole | null;
  /** The community the post was published into. */
  communityVisibility: Visibility;
  /** The community is soft-deleted (decision J13). */
  communityDeleted: boolean;
  /** Viewer holds a `CommunityMember` row on that community. */
  isMember: boolean;
}

/**
 * Direct access to a community post, by id.
 *
 *  1. **A deleted community takes its posts with it** (decision J13). The
 *     posts are not converted back into ordinary global posts; they become
 *     unreadable, including to their authors.
 *  2. `private` → members only. Non-members get `false`, which the caller
 *     renders as 404.
 *  3. `public` and `unlisted` → readable; the post's own visibility is applied
 *     separately by the caller and can still hide it.
 *
 * The platform-admin bypass is honoured for `private` here, unlike Phase 6's
 * placeholder which deliberately refused it — a real membership test now
 * exists, so an admin no longer has to "stand in" for a check that could not be
 * performed. Blocking is still evaluated upstream and still outranks this.
 */
export function canAccessCommunityPost(context: CommunityPostAccessContext): boolean {
  if (context.communityDeleted) return false;

  if (context.communityVisibility === "public") return true;
  if (context.communityVisibility === "unlisted") return true;

  // Private from here down.
  if (context.isMember) return true;
  if (context.viewerRole !== null && isAdminRole(context.viewerRole)) return true;

  return false;
}

/**
 * Whether a community post may appear in the **global** feed.
 *
 * Stricter than direct access, and stricter than membership: only posts in
 * `public` communities are enumerable globally (decision J2). A member of a
 * private community reads its posts on the community page, which owns its own
 * scoped listing — the global feed is a cross-cutting surface, and quietly
 * mixing private-community content into it is how a member of one private
 * space leaks its existence to everyone sharing their screen.
 *
 * Note this takes no viewer: the answer does not depend on who is asking,
 * which is what lets the repository express it as a plain SQL predicate that
 * cannot disagree with this function.
 */
export function isCommunityPostGloballyListable(context: {
  communityVisibility: Visibility;
  communityDeleted: boolean;
}): boolean {
  if (context.communityDeleted) return false;
  return context.communityVisibility === "public";
}

/* ── Joining (decision J5) ───────────────────────────────────────────────── */

/**
 * Why a self-join was refused. Distinguished so the service can answer with
 * the right status: `already_member` is a 409, `private` is a 403, and
 * `not_found` never reaches here — an invisible community is refused by the
 * visibility gate before joining is ever considered.
 */
export type JoinRefusal = "already_member" | "private";

export type JoinDecision = { allowed: true } | { allowed: false; reason: JoinRefusal };

/**
 * Whether a viewer may add *themselves* to a community.
 *
 * There is no pending-membership or invitation state anywhere in this decision
 * because there is no table to persist one (decision J5). `NotificationType`
 * already contains `community_invite`, but no `CommunityInvite` model exists
 * and the schema is frozen, so a private community is joined by being *added*
 * by an owner or admin — a write that goes through the access table in
 * `community.access.ts`, not through here.
 *
 * `unlisted` self-joins succeed: reaching an unlisted community means someone
 * gave you its slug, which is the whole of what "unlisted" protects.
 */
export function resolveJoin(context: {
  visibility: Visibility;
  isMember: boolean;
}): JoinDecision {
  if (context.isMember) return { allowed: false, reason: "already_member" };

  if (context.visibility === "private") {
    return { allowed: false, reason: "private" };
  }

  return { allowed: true };
}
