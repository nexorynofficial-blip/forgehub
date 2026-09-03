import type {
  CommentWithAuthor,
  FeedFilter,
  Paginated,
  PostType,
  PostWithAuthor,
} from "@/types";
import { ApiError, api } from "@/lib/api";

/**
 * A comment as the API actually returns it.
 *
 * **`author` is nullable and the shipped `CommentWithAuthor` says it is not.**
 * The backend soft-deletes a comment that still has live replies: the row
 * survives so the thread does not become orphaned, but its content is replaced
 * and its author stripped. Typed as `CommentWithAuthor`, the first tombstone
 * in a real thread would crash the list on `comment.author.displayName`.
 *
 * `isDeleted` is the discriminant to render on; `replyCount` comes along
 * because the same projection carries it.
 */
export interface FeedComment extends Omit<CommentWithAuthor, "author"> {
  author: CommentWithAuthor["author"] | null;
  isDeleted: boolean;
  replyCount: number;
}

/**
 * Feed, posts and comments (`backend/src/modules/posts`).
 *
 * The cleanest mapping in the project: the backend's `FeedPage` is literally
 * `{ items, nextCursor, total }` — the frontend's own `Paginated<T>` — and its
 * `PostView` carries the embedded `author` that `PostWithAuthor` declares. So
 * `useInfiniteQuery` keeps working with `getNextPageParam: p => p.nextCursor`
 * and no page adapter exists here at all.
 */

/** Additive fields the backend returns beyond the shipped `Post`. */
export interface FeedPost extends PostWithAuthor {
  visibility: "public" | "private" | "unlisted";
  updatedAt: string;
}

/** The viewer's relationship to a post; null for anonymous callers. */
export interface PostViewerState {
  hasLiked: boolean;
  isBookmarked: boolean;
  votedOptionId: string | null;
  isAuthor: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

export interface PostResult {
  post: FeedPost;
  viewer: PostViewerState | null;
}

/* ── Feed ─────────────────────────────────────────────────────────────────── */

/**
 * `GET /feed`.
 *
 * Every filter the UI offers is a real backend filter, `ai_recommended`
 * included — the backend aliases it to `recommended` and says so, which is why
 * the chip stays rather than being removed for lack of a recommender.
 */
export async function getFeedPage({
  filter,
  cursor,
  limit,
}: {
  filter: FeedFilter;
  cursor: string | null;
  limit?: number;
}): Promise<Paginated<FeedPost>> {
  return api.get<Paginated<FeedPost>>("/feed", {
    query: { filter, cursor: cursor ?? undefined, limit },
  });
}

/**
 * `GET /feed/new-count?since=` — backs the "new posts" pill.
 *
 * `since` is a real timestamp the caller owns, so the count is the number of
 * posts that actually landed after the page loaded. The mock counted poll
 * ticks and returned a fabricated 2 on the third call.
 */
export async function checkForNewPosts(
  filter: FeedFilter,
  since: string,
): Promise<number> {
  const { count } = await api.get<{ count: number; since: string }>("/feed/new-count", {
    query: { filter, since },
  });
  return count;
}

/* ── Posts ────────────────────────────────────────────────────────────────── */

export async function getPost(id: string): Promise<PostResult | null> {
  try {
    return await api.get<PostResult>(`/posts/${encodeURIComponent(id)}`);
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) return null;
    throw error;
  }
}

/**
 * `POST /posts`.
 *
 * The author is no longer a parameter. The backend takes it from the access
 * token, which is the only trustworthy source — a client-supplied author is
 * exactly the field a write schema must not accept.
 */
export async function createPost({
  content,
  type,
  projectId,
  communityId,
}: {
  content: string;
  type: PostType;
  projectId?: string;
  communityId?: string;
}): Promise<FeedPost> {
  const { post } = await api.post<{ post: FeedPost }>("/posts", {
    content,
    type,
    ...(projectId ? { projectId } : {}),
    ...(communityId ? { communityId } : {}),
  });
  return post;
}

export async function updatePost(id: string, content: string): Promise<FeedPost> {
  const { post } = await api.patch<{ post: FeedPost }>(
    `/posts/${encodeURIComponent(id)}`,
    { content },
  );
  return post;
}

export async function deletePost(id: string): Promise<void> {
  await api.delete(`/posts/${encodeURIComponent(id)}`);
}

/* ── Post engagement ──────────────────────────────────────────────────────── */

/** Both like calls return the authoritative counter, so nothing is guessed. */
export interface LikeResult {
  liked: boolean;
  likesCount: number;
}

export async function likePost(id: string): Promise<LikeResult> {
  return api.post<LikeResult>(`/posts/${encodeURIComponent(id)}/like`);
}

export async function unlikePost(id: string): Promise<LikeResult> {
  return api.delete<LikeResult>(`/posts/${encodeURIComponent(id)}/like`);
}

export async function bookmarkPost(id: string): Promise<{ bookmarked: boolean }> {
  return api.post(`/posts/${encodeURIComponent(id)}/bookmark`);
}

export async function unbookmarkPost(id: string): Promise<{ bookmarked: boolean }> {
  return api.delete(`/posts/${encodeURIComponent(id)}/bookmark`);
}

/** `GET /users/me/bookmarks` — cursor-paginated. */
export async function getBookmarks(options: { cursor?: string; limit?: number } = {}) {
  return api.get<{ items: FeedPost[]; nextCursor: string | null }>(
    "/users/me/bookmarks",
    { query: { cursor: options.cursor, limit: options.limit } },
  );
}

/**
 * `POST /posts/{id}/poll/vote` — returns the recalculated option counts, so
 * the bar chart redraws from the server rather than from a local increment.
 */
export async function votePoll(
  postId: string,
  optionId: string,
): Promise<{
  votedOptionId: string;
  options: { id: string; label: string; voteCount: number }[];
}> {
  return api.post(`/posts/${encodeURIComponent(postId)}/poll/vote`, { optionId });
}

/* ── Comments ─────────────────────────────────────────────────────────────── */

export interface CommentPage {
  comments: FeedComment[];
  nextCursor: string | null;
}

/** `GET /posts/{id}/comments` — top-level comments, cursor-paginated. */
export async function getCommentsForPost(
  postId: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<CommentPage> {
  return api.get<CommentPage>(`/posts/${encodeURIComponent(postId)}/comments`, {
    query: { cursor: options.cursor, limit: options.limit },
  });
}

/** `GET /comments/{id}/replies` — one thread below a comment. */
export async function getCommentReplies(
  commentId: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<CommentPage> {
  return api.get<CommentPage>(`/comments/${encodeURIComponent(commentId)}/replies`, {
    query: { cursor: options.cursor, limit: options.limit },
  });
}

/**
 * `POST /posts/{id}/comments`.
 *
 * `parentCommentId` is how a reply is addressed; omitting it posts at top
 * level. As with posts, the author comes from the token, not the caller.
 */
export async function addComment(
  postId: string,
  content: string,
  parentCommentId?: string,
): Promise<FeedComment> {
  const { comment } = await api.post<{ comment: FeedComment }>(
    `/posts/${encodeURIComponent(postId)}/comments`,
    { content, ...(parentCommentId ? { parentCommentId } : {}) },
  );
  return comment;
}

export async function updateComment(
  commentId: string,
  content: string,
): Promise<FeedComment> {
  const { comment } = await api.patch<{ comment: FeedComment }>(
    `/comments/${encodeURIComponent(commentId)}`,
    { content },
  );
  return comment;
}

export async function deleteComment(commentId: string): Promise<void> {
  await api.delete(`/comments/${encodeURIComponent(commentId)}`);
}

export async function likeComment(commentId: string): Promise<LikeResult> {
  return api.post<LikeResult>(`/comments/${encodeURIComponent(commentId)}/like`);
}

export async function unlikeComment(commentId: string): Promise<LikeResult> {
  return api.delete<LikeResult>(`/comments/${encodeURIComponent(commentId)}/like`);
}
