import type { ProfileVisibility, UserRole, Visibility } from "@prisma/client";

/**
 * Search authorization and query rules, as pure functions (Phase 10).
 *
 * No Prisma client import, no I/O, no HTTP. Two jobs:
 *
 *   1. **Query normalization** — what counts as a usable search term.
 *   2. **Visibility rules** — which rows a viewer may discover, expressed as
 *      predicates the unit tests pin directly.
 *
 * The predicates here are the *mirror* of the `where` clauses in
 * `search.repository.ts`, exactly as `project.visibility.ts` mirrors
 * `projects.repository.listVisibilityWhere` and `community.visibility.ts`
 * mirrors its own. The duplication is deliberate and restates the Phase 5
 * lesson: the pure function is what the tests pin the rules to, and the SQL is
 * what stops a hidden row from consuming a page slot or inflating a count.
 * `tests/search-repo.test.ts` asserts the two agree on real rows, so they
 * cannot drift silently.
 *
 * ## What the repository reuses, and what it re-expresses
 *
 * The predicates below cover all five entities so the unit tests can pin every
 * rule without a database. The SQL side reuses a domain helper wherever one is
 * reachable: `posts.repository.ts` and `communities.repository.ts` both export
 * their `listVisibilityWhere`, so the search repository calls them rather than
 * writing a second copy. `projects.repository.ts` keeps its helper
 * module-private, and Phase 10 may not modify a previous-phase file merely to
 * widen an export, so that one clause is re-expressed. Users have never had a
 * set-level helper at all — `users/visibility.ts` decides one profile at a
 * time — so that clause is new.
 *
 * ## Admins get nothing extra (ruling D8)
 *
 * `projects.repository.listVisibilityWhere` and its community counterpart both
 * widen for admin roles. **Search does not.** Search is discovery, not
 * moderation, and admin tooling is Phase 11. The viewer's role is not a
 * parameter of any function below, so there is no branch that could grow one.
 */

/* ── Query normalization (ruling D11) ────────────────────────────────────── */

export const MIN_QUERY_LENGTH = 1;
export const MAX_QUERY_LENGTH = 100;

/**
 * The characters PostgreSQL's `LIKE`/`ILIKE` treats as wildcards.
 *
 * Prisma's `contains` does **not** escape these. Verified against the running
 * database: `contains: "100%_x"` compiles to `ILIKE $1` with the bound
 * parameter `"%100%_x%"`. There is no `ESCAPE` clause available through the
 * query API, and ruling D2 forbids raw SQL, so they cannot be neutralized.
 *
 * The consequence is bounded and worth stating plainly: a term containing `%`
 * or `_` **over-matches and never under-matches**. `snake_case` still finds
 * `snake_case` — an `_` matches an `_` — it merely also finds `snakeXcase`.
 * That is a loss of precision, not a leak: the visibility clause is a separate
 * `AND` that no wildcard can escape.
 *
 * The one case that is not merely imprecise is a term made *entirely* of
 * wildcards. `%` alone compiles to `ILIKE '%%%'`, which matches every row and
 * turns search into a bulk enumeration of everything the viewer may see. That
 * is rejected by `isEffectivelyEmpty` below.
 */
const LIKE_WILDCARDS = new Set(["%", "_"]);

/** Trims and collapses internal whitespace. Case folding is the query's job. */
export function normalizeQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/**
 * Whether a normalized term carries no actual search intent.
 *
 * Empty and whitespace-only are the cases ruling D11 names. Wildcard-only is
 * the third: syntactically non-empty, semantically "give me everything", for
 * the reason above.
 */
export function isEffectivelyEmpty(normalized: string): boolean {
  if (normalized.length === 0) return true;
  return [...normalized].every(
    (character) => LIKE_WILDCARDS.has(character) || character === " ",
  );
}

/** A term is usable when it normalizes to something with real intent. */
export function isUsableQuery(raw: string): boolean {
  const normalized = normalizeQuery(raw);
  return (
    !isEffectivelyEmpty(normalized) &&
    normalized.length >= MIN_QUERY_LENGTH &&
    normalized.length <= MAX_QUERY_LENGTH
  );
}

/* ── Which groups a request asks for ─────────────────────────────────────── */

export const SEARCH_TYPES = [
  "all",
  "users",
  "projects",
  "communities",
  "posts",
  "tags",
] as const;

export type SearchTypeName = (typeof SEARCH_TYPES)[number];

/** The five searchable entities, in the order the response presents them. */
export const SEARCH_ENTITIES = [
  "users",
  "projects",
  "communities",
  "posts",
  "tags",
] as const;

export type SearchEntity = (typeof SEARCH_ENTITIES)[number];

/**
 * Whether one entity group should be queried at all.
 *
 * A filtered-out group is skipped rather than queried and discarded: four
 * unnecessary counts plus four unnecessary page queries per request is the
 * difference between a filtered search costing one round of work and five.
 */
export function shouldSearch(entity: SearchEntity, type: SearchTypeName): boolean {
  return type === "all" || type === entity;
}

/* ── Sorting (ruling D6) ─────────────────────────────────────────────────── */

/**
 * The complete sort allow-list.
 *
 * **No relevance score.** Ruling D6 forbids inventing one, and there would be
 * nothing to compute it from: ruling D2 pins matching to `ILIKE`, which yields
 * a boolean, not a rank. Sorting is therefore explicit and deterministic, and
 * every key maps to a real column — most already indexed by the Phase 2
 * schema.
 *
 * A caller-supplied sort never reaches the database as a string. The schema
 * parses it into this union and the repository switches on the union to build
 * an `orderBy`, so an unknown value is a 422 rather than something that could
 * reach a query builder.
 */
export const SEARCH_SORTS = ["recent", "popular"] as const;

export type SearchSortName = (typeof SEARCH_SORTS)[number];

export function isSearchSort(value: string): value is SearchSortName {
  return (SEARCH_SORTS as readonly string[]).includes(value);
}

/* ── Visibility: users ───────────────────────────────────────────────────── */

export interface UserVisibilityContext {
  viewerId: string | null;
  targetId: string;
  deleted: boolean;
  /** `public` when the target has no profile row — the schema's own default. */
  targetVisibility: ProfileVisibility;
  /** The viewer follows the target. */
  isFollowing: boolean;
  /** The **target** has blocked the **viewer**. */
  targetBlockedViewer: boolean;
}

/**
 * Whether a user may appear in another user's search results.
 *
 * The set-level counterpart to `users/visibility.ts:resolveVisibility`, with
 * two deliberate differences:
 *
 *   - **No admin branch** (ruling D8). `resolveVisibility` grants admins the
 *     full profile because moderation cannot work through a redacted view;
 *     discovery has no such need.
 *   - **No `redacted` outcome.** A listing either appears or does not.
 *     Returning an identity-only shell would announce that a followers-only
 *     account exists at a given handle, which is what the setting exists to
 *     prevent.
 *
 * Order matches the Phase 4 original: blocking wins over everything, then
 * self, then the visibility setting.
 */
export function isUserDiscoverable(context: UserVisibilityContext): boolean {
  if (context.deleted) return false;
  if (context.targetBlockedViewer) return false;
  if (context.viewerId !== null && context.viewerId === context.targetId) return true;
  if (context.targetVisibility === "public") return true;
  // `isFollowing` is re-guarded on the viewer rather than trusted: nobody
  // anonymous follows anyone, and the SQL counterpart cannot express such a
  // row either. Without this, an incoherent context would make the mirror
  // *more* permissive than the query it mirrors — the one direction in which
  // the two must never disagree.
  return context.viewerId !== null && context.isFollowing;
}

/* ── Visibility: projects and communities ────────────────────────────────── */

export interface OwnedVisibilityContext {
  viewerId: string | null;
  ownerId: string;
  deleted: boolean;
  visibility: Visibility;
  /** The viewer is a member/collaborator of the subject. */
  isMember: boolean;
  /** The **owner** has blocked the **viewer**. */
  ownerBlockedViewer: boolean;
}

/**
 * Whether a project may appear in search results.
 *
 * Mirrors `projects.repository.listVisibilityWhere` **minus its admin branch**
 * (ruling D8). `unlisted` is excluded for non-members by construction: the
 * allowed set is public, own, or member, and `unlisted` means "reachable by
 * link, not by listing" — a search result is a listing.
 */
export function isProjectDiscoverable(context: OwnedVisibilityContext): boolean {
  if (context.deleted) return false;
  if (context.viewerId === null) return context.visibility === "public";
  if (context.ownerBlockedViewer) return false;
  if (context.visibility === "public") return true;
  if (context.viewerId === context.ownerId) return true;
  return context.isMember;
}

/** Identical rules for communities; see `isProjectDiscoverable`. */
export function isCommunityDiscoverable(context: OwnedVisibilityContext): boolean {
  return isProjectDiscoverable(context);
}

/* ── Visibility: posts ───────────────────────────────────────────────────── */

export interface PostVisibilityContext {
  viewerId: string | null;
  authorId: string;
  deleted: boolean;
  visibility: Visibility;
  /** Null when the post is not in a community. */
  communityVisibility: Visibility | null;
  communityDeleted: boolean;
  /** The **author** has blocked the **viewer**. */
  authorBlockedViewer: boolean;
}

/**
 * Whether a post may appear in search results.
 *
 * Mirrors `posts.repository.listVisibilityWhere`, which has no admin branch to
 * begin with. The community rule and the post-visibility rule are independent
 * conjuncts — a public post inside a private community is not discoverable,
 * and an author's own private post is — so they cannot be collapsed into one
 * disjunction.
 *
 * Membership of a private community is deliberately **not** consulted, exactly
 * as Phase 6 decided for the feed: a member reads their private community's
 * posts on the community page, which owns its own scoped listing. Widening
 * here would mix private-community content into a global surface.
 */
export function isPostDiscoverable(context: PostVisibilityContext): boolean {
  if (context.deleted) return false;

  const communityListable =
    context.communityVisibility === null ||
    (context.communityVisibility === "public" && !context.communityDeleted);
  if (!communityListable) return false;

  if (context.viewerId === null) return context.visibility === "public";
  if (context.authorBlockedViewer) return false;
  return context.visibility === "public" || context.viewerId === context.authorId;
}

/* ── Visibility: tags ────────────────────────────────────────────────────── */

/**
 * Tags are unconditionally discoverable.
 *
 * `Tag` carries no `visibility`, no `deletedAt`, and no owner — it is curated
 * taxonomy rather than user content, and ruling D10 keeps it that way. The
 * function exists so all five entities read uniformly at the call site, and so
 * a later phase adding tag moderation has an obvious place to put the rule.
 */
export function isTagDiscoverable(): boolean {
  return true;
}

/* ── Guard against an admin bypass creeping in ───────────────────────────── */

/**
 * Deliberately discards the viewer's role.
 *
 * Exported so `tests/search-security.test.ts` can assert the property rather
 * than merely trust that no branch reads a role: search visibility is a
 * function of identity and relationship only. `search.repository.ts` passes
 * this through to every reused domain helper, which is what structurally
 * disables their admin branches.
 */
export function effectiveViewerRole(_role: UserRole | null): null {
  return null;
}
