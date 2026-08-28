import type { Pagination } from "../../utils/response.js";
import type {
  CommunitySearchRow,
  PostSearchRow,
  ProjectSearchRow,
  TagSearchRow,
  UserSearchRow,
} from "./search.repository.js";
import type {
  CommunitySearchResultView,
  PostSearchResultView,
  ProjectSearchResultView,
  SearchGroup,
  TagSearchResultView,
  UserSearchResultView,
} from "./search.types.js";

/**
 * The projection layer for search.
 *
 * Nothing outside this file turns a Prisma row into a search response — the
 * same chokepoint `user.view.ts`, `project.view.ts`, `post.view.ts`,
 * `community.view.ts`, `message.view.ts`, and `notification.view.ts`
 * established.
 *
 * Every projection is built **by construction**. None starts from a row and
 * deletes keys, because an omission list starts leaking the day someone adds a
 * column. That discipline matters more here than anywhere else in the API:
 * search touches five tables at once, and `User` in particular carries
 * `email`, `passwordHash`, `role`, and `status` — none of which any function
 * below can emit, because none of them is ever named.
 *
 * The repository's selects are already narrow, so this layer is a second line
 * rather than the only one. Both are deliberate: a widened select would still
 * produce a correct response, and a widened response shape would still be fed
 * only the fields the select fetched.
 */

function toIso(value: Date): string {
  return value.toISOString();
}

/** Tag join rows arrive as `{ tag: { name } }`; the response wants names. */
function toTagNames(rows: { tag: { name: string } }[]): string[] {
  return rows.map((row) => row.tag.name);
}

/**
 * A user, whether they are the subject of a result or the actor behind one.
 *
 * `bio` is served because it is what makes a person-shaped result legible in a
 * list; it is safe because a user only reaches this function after the
 * visibility clause has already established that the viewer may see them at
 * all. `avatarUrl` and `bio` both come from the optional `Profile` relation and
 * go null together when there is no row.
 */
export function toUserResult(row: UserSearchRow): UserSearchResultView {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    builderRank: row.builderRank,
    avatarUrl: row.profile?.avatarUrl ?? null,
    bio: row.profile?.bio ?? null,
  };
}

export function toProjectResult(row: ProjectSearchRow): ProjectSearchResultView {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    coverImageUrl: row.coverImageUrl,
    status: row.status,
    visibility: row.visibility,
    likesCount: row.likesCount,
    followersCount: row.followersCount,
    createdAt: toIso(row.createdAt),
    // `onDelete: Restrict` means an owner cannot vanish, but the projection
    // tolerates it rather than asserting it — a null owner renders as an
    // ownerless card, where a throw here would fail the whole search.
    owner: row.owner === null ? null : toUserResult(row.owner),
    tags: toTagNames(row.tags),
  };
}

export function toCommunityResult(row: CommunitySearchRow): CommunitySearchResultView {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    avatarUrl: row.avatarUrl,
    category: row.category,
    visibility: row.visibility,
    memberCount: row.memberCount,
    createdAt: toIso(row.createdAt),
    tags: toTagNames(row.tags),
  };
}

export function toPostResult(row: PostSearchRow): PostSearchResultView {
  return {
    id: row.id,
    type: row.type,
    content: row.content,
    visibility: row.visibility,
    likesCount: row.likesCount,
    commentsCount: row.commentsCount,
    createdAt: toIso(row.createdAt),
    author: row.author === null ? null : toUserResult(row.author),
  };
}

export function toTagResult(row: TagSearchRow): TagSearchResultView {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    usageCount: row.usageCount,
  };
}

/**
 * Wraps one entity's rows and its visible total into a group.
 *
 * `pagination.total` is the count taken under the *same* `where` as the rows,
 * so a group whose page is empty on page 3 of 5 still reports the truthful
 * number of matches the viewer may see — and never one row more.
 */
export function toGroup<TRow, TView>(
  result: { rows: TRow[]; total: number },
  pagination: Pagination,
  project: (row: TRow) => TView,
): SearchGroup<TView> {
  return { items: result.rows.map(project), pagination };
}

/** The group a skipped entity gets: empty, present, and honest about it. */
export function emptyGroup<TView>(pagination: Pagination): SearchGroup<TView> {
  return { items: [], pagination: { ...pagination, total: 0, totalPages: 0 } };
}
