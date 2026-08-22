import { AppError } from "../../utils/errors.js";
import { buildCursorPage } from "../../utils/pagination.js";
import * as usersRepo from "../users/users.repository.js";
import * as follows from "../follows/follows.repository.js";
import * as repo from "./posts.repository.js";
import { projectPage, resolveVotes, type Viewer } from "./posts.service.js";
import type { FeedQuery, NewCountQuery, CursorQuery } from "./posts.schema.js";
import type { FeedPage } from "./posts.types.js";

/**
 * The feed (BACKEND_ARCHITECTURE.md §11, decision J5).
 *
 * §11 is explicit that this phase must not build a recommendation engine, so
 * every filter is a database query over an indexed column and nothing more.
 * The ranking *signals* §11 lists — recency, engagement, follow relationships —
 * are each represented; combining them into a learned score is Phase 12.
 *
 * Visibility is applied in SQL by `listVisibilityWhere`, not after the fact, so
 * a hidden post can never consume a page slot or inflate `total`.
 */

export async function getFeed(viewer: Viewer, query: FeedQuery): Promise<FeedPage> {
  const { rows, total } = await repo.listFeed(
    viewer,
    query.filter,
    query.cursor,
    query.limit,
  );

  const page = buildCursorPage(rows, query.limit, (row) => row.id);
  const votes = await resolveVotes(page.items, viewer.id);

  return {
    items: projectPage(page.items, votes),
    nextCursor: page.nextCursor,
    total,
  };
}

/**
 * Backs the shipped "new posts" pill (decision J10).
 *
 * One indexed `COUNT` against the same filter the caller is looking at, so the
 * number it reports is the number of posts they would actually receive — a
 * count taken against a different visibility scope would promise rows the feed
 * then refuses to return.
 */
export async function getNewCount(
  viewer: Viewer,
  query: NewCountQuery,
): Promise<{ count: number; since: string }> {
  const count = await repo.countNewSince(viewer, query.filter, query.since);
  return { count, since: query.since.toISOString() };
}

/**
 * A profile's posts.
 *
 * Routed through the users repository so a profile that is itself hidden
 * cannot leak its posts: a blocked viewer gets the same 404 the profile would
 * give them, rather than an empty array that confirms the account exists —
 * the rule Phase 5 established for a project owner's listing.
 */
export async function getByAuthor(
  username: string,
  viewer: Viewer,
  query: CursorQuery,
): Promise<FeedPage> {
  const author = await usersRepo.findByUsername(username);

  if (!author) {
    throw AppError.notFound("User not found");
  }

  if (viewer.id !== null && viewer.id !== author.id) {
    const blocked = await follows.isBlocking(author.id, viewer.id);
    if (blocked) {
      throw AppError.notFound("User not found");
    }
  }

  const rows = await repo.listByAuthor(author.id, viewer, query.cursor, query.limit);
  const page = buildCursorPage(rows, query.limit, (row) => row.id);
  const votes = await resolveVotes(page.items, viewer.id);

  return {
    items: projectPage(page.items, votes),
    nextCursor: page.nextCursor,
    total: page.items.length,
  };
}

/** The caller's own bookmarks. Never exposed for another user. */
export async function getBookmarks(
  userId: string,
  viewer: Viewer,
  query: CursorQuery,
): Promise<FeedPage> {
  const rows = await repo.listBookmarked(userId, query.cursor, query.limit);
  const page = buildCursorPage(rows, query.limit, (row) => row.cursorId);
  const posts = page.items.map((row) => row.post);
  const votes = await resolveVotes(posts, viewer.id);

  return {
    items: projectPage(posts, votes),
    nextCursor: page.nextCursor,
    total: posts.length,
  };
}
