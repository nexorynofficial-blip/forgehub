import { Prisma } from "@prisma/client";

import { prisma } from "../../database/prisma.js";
import { listVisibilityWhere as communityListVisibilityWhere } from "../communities/communities.repository.js";
import { listVisibilityWhere as postListVisibilityWhere } from "../posts/posts.repository.js";
import { effectiveViewerRole, type SearchSortName } from "./search.access.js";

/**
 * Data access for search (Phase 10).
 *
 * The only layer that touches Prisma, as in every module since Phase 4.
 *
 * ## Matching (ruling D2)
 *
 * `contains` with `mode: "insensitive"`, which compiles to `ILIKE '%term%'`.
 * No full-text search, no `pg_trgm`, no `tsvector`, no GIN index, no raw SQL,
 * and therefore **no migration** — the schema and its two migrations are
 * untouched by this phase.
 *
 * The cost is stated rather than hidden: `ILIKE '%term%'` cannot use a B-tree
 * index and is a sequential scan. That is the same trade Phase 7's community
 * `q` filter and Phase 8's message search already make, and it is a deliberate
 * ceiling, not an oversight. Raising it needs a GIN index, which needs a
 * migration, which is a decision above this phase.
 *
 * ## Visibility
 *
 * Every query applies its visibility clause **in SQL**, never after fetching.
 * Phase 5 recorded why and it is doubly true here: a post-fetch filter returns
 * short pages *and* reports a `total` that counts rows the viewer may not see,
 * which turns a paging bug into a disclosure channel.
 *
 * Where a domain module exports its own listing filter, this file calls it
 * rather than writing a second copy — `posts` and `communities` both do.
 * Every such call passes `role: effectiveViewerRole(...)`, which is always
 * `null`: that is what structurally disables the admin-widening branch inside
 * `communities.listVisibilityWhere`, per ruling D8. Passing the viewer's real
 * role would silently grant moderators a wider search than everyone else.
 *
 * ## Counting
 *
 * Each group runs a `findMany` and a `count` **against the identical `where`**,
 * built once and shared, so the two can never disagree about what is visible.
 */

/* ── Search term ─────────────────────────────────────────────────────────── */

/** One `ILIKE '%term%'` predicate. Case folding is PostgreSQL's, not ours. */
function like(term: string): Prisma.StringFilter {
  return { contains: term, mode: "insensitive" };
}

/* ── Deterministic ordering (ruling D6) ──────────────────────────────────── */

/**
 * Every ordering ends in `id: "desc"`.
 *
 * Without it, rows sharing a `createdAt` millisecond or a `likesCount` have no
 * defined order, and offset paging would be free to show the same row on two
 * pages and skip another entirely. Phase 9 broke its cursor ties the same way.
 */
type Direction = Prisma.SortOrder;
const DESC: Direction = "desc";

function userOrder(sort: SearchSortName): Prisma.UserOrderByWithRelationInput[] {
  // `popular` rides `users(xp DESC)`; `recent` rides `users(createdAt)`.
  return sort === "popular"
    ? [{ xp: DESC }, { id: DESC }]
    : [{ createdAt: DESC }, { id: DESC }];
}

function projectOrder(sort: SearchSortName): Prisma.ProjectOrderByWithRelationInput[] {
  return sort === "popular"
    ? [{ likesCount: DESC }, { id: DESC }]
    : [{ createdAt: DESC }, { id: DESC }];
}

function communityOrder(
  sort: SearchSortName,
): Prisma.CommunityOrderByWithRelationInput[] {
  return sort === "popular"
    ? [{ memberCount: DESC }, { id: DESC }]
    : [{ createdAt: DESC }, { id: DESC }];
}

function postOrder(sort: SearchSortName): Prisma.PostOrderByWithRelationInput[] {
  return sort === "popular"
    ? [{ likesCount: DESC }, { id: DESC }]
    : [{ createdAt: DESC }, { id: DESC }];
}

function tagOrder(sort: SearchSortName): Prisma.TagOrderByWithRelationInput[] {
  // `popular` rides `tags(usageCount DESC)` — the index Phase 2 added for
  // exactly this phase and which nothing has used until now.
  return sort === "popular"
    ? [{ usageCount: DESC }, { id: DESC }]
    : [{ createdAt: DESC }, { id: DESC }];
}

/* ── Projections ─────────────────────────────────────────────────────────── */

/**
 * The actor projection, shared by project owners and post authors.
 *
 * Five fields. `email`, `role`, and `status` are absent **by construction**,
 * not by omission from a wider select: search is the widest read surface in
 * the API, so it gets the narrowest projection in it.
 */
const actorSelect = {
  id: true,
  username: true,
  displayName: true,
  builderRank: true,
  profile: { select: { avatarUrl: true, bio: true } },
} satisfies Prisma.UserSelect;

const userSelect = actorSelect;

export type UserSearchRow = Prisma.UserGetPayload<{ select: typeof userSelect }>;

const projectSelect = {
  id: true,
  slug: true,
  title: true,
  description: true,
  coverImageUrl: true,
  status: true,
  visibility: true,
  likesCount: true,
  followersCount: true,
  createdAt: true,
  owner: { select: actorSelect },
  tags: { select: { tag: { select: { name: true } } } },
} satisfies Prisma.ProjectSelect;

export type ProjectSearchRow = Prisma.ProjectGetPayload<{ select: typeof projectSelect }>;

const communitySelect = {
  id: true,
  slug: true,
  name: true,
  description: true,
  avatarUrl: true,
  category: true,
  visibility: true,
  memberCount: true,
  createdAt: true,
  tags: { select: { tag: { select: { name: true } } } },
} satisfies Prisma.CommunitySelect;

export type CommunitySearchRow = Prisma.CommunityGetPayload<{
  select: typeof communitySelect;
}>;

const postSelect = {
  id: true,
  type: true,
  content: true,
  visibility: true,
  likesCount: true,
  commentsCount: true,
  createdAt: true,
  author: { select: actorSelect },
} satisfies Prisma.PostSelect;

export type PostSearchRow = Prisma.PostGetPayload<{ select: typeof postSelect }>;

const tagSelect = {
  id: true,
  slug: true,
  name: true,
  usageCount: true,
} satisfies Prisma.TagSelect;

export type TagSearchRow = Prisma.TagGetPayload<{ select: typeof tagSelect }>;

/* ── Visibility clauses ──────────────────────────────────────────────────── */

/**
 * Users a viewer may discover.
 *
 * New in this phase, because no set-level equivalent existed:
 * `users/visibility.ts:resolveVisibility` decides **one loaded profile** at a
 * time and returns `full | redacted | not_found`, which cannot be pushed into
 * a `WHERE`. This is its listing counterpart and must agree with
 * `search.access.isUserDiscoverable` branch for branch.
 *
 * `profile: { is: null }` is a real case, not defensive padding: `Profile` is
 * an optional relation, a freshly registered account has no row yet, and the
 * schema's default is `public`. Treating a missing profile as hidden would
 * make every new account undiscoverable until it opened its settings.
 *
 * There is deliberately no admin branch (ruling D8) and no `redacted` middle
 * ground — a followers-only account is absent from a stranger's results
 * entirely, because an identity-only shell would still confirm the handle.
 */
function userVisibilityWhere(viewerId: string | null): Prisma.UserWhereInput {
  const publiclyVisible: Prisma.UserWhereInput[] = [
    { profile: { is: null } },
    { profile: { visibility: "public" } },
  ];

  if (viewerId === null) {
    return { deletedAt: null, OR: publiclyVisible };
  }

  return {
    deletedAt: null,
    // The target has not blocked the viewer. Same shape as the `owner
    // .blocksMade` / `author.blocksMade` clauses in projects and posts.
    blocksMade: { none: { blockedId: viewerId } },
    OR: [
      { id: viewerId },
      ...publiclyVisible,
      // A followers-only profile opens to confirmed followers. `followers` is
      // the `Follow` rows pointing *at* this user, so this asks "does the
      // viewer follow them", not the reverse.
      { followers: { some: { followerId: viewerId } } },
    ],
  };
}

/**
 * Projects a viewer may discover.
 *
 * Re-expressed rather than imported: `projects.repository.listVisibilityWhere`
 * is module-private and Phase 10 may not modify a previous-phase file to widen
 * an export. It is otherwise identical **except that the admin branch is
 * absent** (ruling D8), which is the same net effect the `role: null` argument
 * has on the two helpers this file does import.
 *
 * `tests/search-repo.test.ts` pins the equivalence against real rows so the
 * copy cannot drift.
 */
function projectVisibilityWhere(viewerId: string | null): Prisma.ProjectWhereInput {
  if (viewerId === null) {
    return { deletedAt: null, visibility: "public" };
  }

  return {
    deletedAt: null,
    owner: { blocksMade: { none: { blockedId: viewerId } } },
    OR: [
      { visibility: "public" },
      { ownerId: viewerId },
      { members: { some: { userId: viewerId } } },
    ],
  };
}

/* ── Queries ─────────────────────────────────────────────────────────────── */

export interface SearchPage {
  skip: number;
  take: number;
  sort: SearchSortName;
}

export interface SearchResult<TRow> {
  rows: TRow[];
  total: number;
}

/**
 * Runs a page query and a count against the *same* `where`.
 *
 * Sharing the object is the point: two separately built clauses could drift,
 * and a `total` computed from a wider clause than the page would report the
 * existence of rows the viewer cannot see. That is the disclosure this helper
 * exists to make structurally impossible.
 */
async function paged<TRow>(
  findMany: () => Promise<TRow[]>,
  count: () => Promise<number>,
): Promise<SearchResult<TRow>> {
  const [rows, total] = await Promise.all([findMany(), count()]);
  return { rows, total };
}

/** Users matching on `username` or `displayName`. */
export async function searchUsers(
  term: string,
  viewerId: string | null,
  page: SearchPage,
): Promise<SearchResult<UserSearchRow>> {
  // Identity fields only. `bio` is projected but not matched: a search that
  // surfaced people by the prose of their profile would make a bio a public
  // index of its author, which is not what PRD §15's "Users" asks for.
  const where: Prisma.UserWhereInput = {
    AND: [
      userVisibilityWhere(viewerId),
      { OR: [{ username: like(term) }, { displayName: like(term) }] },
    ],
  };

  return paged(
    () =>
      prisma.user.findMany({
        where,
        select: userSelect,
        orderBy: userOrder(page.sort),
        skip: page.skip,
        take: page.take,
      }),
    () => prisma.user.count({ where }),
  );
}

/** Projects matching on `title` or `description`. */
export async function searchProjects(
  term: string,
  viewerId: string | null,
  page: SearchPage,
): Promise<SearchResult<ProjectSearchRow>> {
  /*
   * The visibility clause and the term clause both want `OR`, and one object
   * literal cannot hold two — the second key would replace the first and widen
   * visibility into "matches the search", leaking private projects. Both go
   * under `AND`, where they compose. Phase 7 hit exactly this and left the
   * warning in `communities.repository.ts`.
   */
  const where: Prisma.ProjectWhereInput = {
    AND: [
      projectVisibilityWhere(viewerId),
      { OR: [{ title: like(term) }, { description: like(term) }] },
    ],
  };

  return paged(
    () =>
      prisma.project.findMany({
        where,
        select: projectSelect,
        orderBy: projectOrder(page.sort),
        skip: page.skip,
        take: page.take,
      }),
    () => prisma.project.count({ where }),
  );
}

/** Communities matching on `name` or `description`. */
export async function searchCommunities(
  term: string,
  viewerId: string | null,
  page: SearchPage,
): Promise<SearchResult<CommunitySearchRow>> {
  const where: Prisma.CommunityWhereInput = {
    AND: [
      // Reused from Phase 7. `role` is forced to null so the helper's admin
      // branch cannot fire — ruling D8 expressed as an argument rather than a
      // comment.
      communityListVisibilityWhere({ id: viewerId, role: effectiveViewerRole(null) }),
      { OR: [{ name: like(term) }, { description: like(term) }] },
    ],
  };

  return paged(
    () =>
      prisma.community.findMany({
        where,
        select: communitySelect,
        orderBy: communityOrder(page.sort),
        skip: page.skip,
        take: page.take,
      }),
    () => prisma.community.count({ where }),
  );
}

/** Posts matching on `content`. */
export async function searchPosts(
  term: string,
  viewerId: string | null,
  page: SearchPage,
): Promise<SearchResult<PostSearchRow>> {
  // `codeContent` is deliberately not matched. Code search on a builder
  // platform is plausible, but PRD §15 says "Posts" and nothing more, and
  // adding a second matched column is a product decision this phase was not
  // given.
  const where: Prisma.PostWhereInput = {
    AND: [
      // Reused from Phase 6, which has no admin branch to begin with; the null
      // role is passed anyway so every reuse site here reads identically.
      postListVisibilityWhere({ id: viewerId, role: effectiveViewerRole(null) }),
      { content: like(term) },
    ],
  };

  return paged(
    () =>
      prisma.post.findMany({
        where,
        select: postSelect,
        orderBy: postOrder(page.sort),
        skip: page.skip,
        take: page.take,
      }),
    () => prisma.post.count({ where }),
  );
}

/** Tags matching on `name` or `slug` — both, per the Phase 10 brief. */
export async function searchTags(
  term: string,
  page: SearchPage,
): Promise<SearchResult<TagSearchRow>> {
  // No viewer parameter, and that is the rule rather than an omission: `Tag`
  // has no `visibility`, no `deletedAt`, and no owner. It is curated taxonomy
  // (ruling D10), so every tag is discoverable by everyone.
  const where: Prisma.TagWhereInput = {
    OR: [{ name: like(term) }, { slug: like(term) }],
  };

  return paged(
    () =>
      prisma.tag.findMany({
        where,
        select: tagSelect,
        orderBy: tagOrder(page.sort),
        skip: page.skip,
        take: page.take,
      }),
    () => prisma.tag.count({ where }),
  );
}
