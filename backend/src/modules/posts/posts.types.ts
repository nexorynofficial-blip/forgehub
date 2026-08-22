import type { MediaType, PostType, Visibility } from "@prisma/client";

import type { UserSummaryView } from "../users/users.types.js";

/**
 * Contracts for the posts module.
 *
 * `PostView` mirrors the shipped frontend's `Post` (`src/types/post.ts`) key
 * for key, and `author` is `UserSummaryView` — which *is* the frontend's
 * `PostAuthor` (`src/types/feed.ts`) field for field. That is not a
 * coincidence: Phase 4 built `toUserSummary` against `PostAuthor` precisely so
 * this phase would not have to invent a second shape.
 *
 * Additive keys (`visibility`, `updatedAt`, `author`, `media`) are inert for
 * the shipped components, the same superset argument the response envelope and
 * `ProjectView` already make.
 */

/** Mirrors the frontend's `CodeSnippet`. Two columns, not a child table. */
export interface CodeSnippetView {
  language: string;
  code: string;
}

/** Mirrors the frontend's `PollOption` — no `position`; order is the array. */
export interface PollOptionView {
  id: string;
  label: string;
  voteCount: number;
}

/**
 * Mirrors the frontend's `Poll`, which deliberately has **no `id`** —
 * `PollVoter` receives the poll and votes by `option.id`. `id` and
 * `votedOptionId` are additive so a reload can restore what the viewer chose.
 */
export interface PollView {
  question: string;
  options: PollOptionView[];
  closesAt: string | null;

  id: string;
  /** The option this viewer picked, or null. Null for anonymous callers. */
  votedOptionId: string | null;
  /** True once `closesAt` has passed; votes are refused after that. */
  isClosed: boolean;
}

/** Richer media, additive alongside the flat `mediaUrls` the frontend reads. */
export interface PostMediaView {
  url: string;
  type: MediaType;
  position: number;
  width: number | null;
  height: number | null;
}

/**
 * The full post.
 *
 * `mediaUrls` is a flat `string[]` ordered by `PostMedia.position`, because
 * `post-type-content.tsx` maps over exactly that. The structured `media` array
 * carries what the flat form cannot.
 */
export interface PostView {
  id: string;
  authorId: string;
  projectId: string | null;
  type: PostType;
  content: string;
  mediaUrls: string[];
  codeSnippet: CodeSnippetView | null;
  poll: PollView | null;
  likesCount: number;
  commentsCount: number;
  createdAt: string;

  /* ── Additive beyond the frontend's `Post` ──────────────────────────────
     `communityId` is deliberately NOT here (decision J9): community
     visibility depends on a `Community` that Phase 7 owns, and exposing the
     field would invite clients to depend on a linkage this phase cannot
     enforce. */

  visibility: Visibility;
  updatedAt: string;
  media: PostMediaView[];
  /** Mirrors the frontend's `PostWithAuthor.author`. */
  author: UserSummaryView;
}

/** Mirrors the frontend's `Comment` (`src/types/post.ts`). */
export interface CommentView {
  id: string;
  postId: string;
  authorId: string;
  parentCommentId: string | null;
  content: string;
  likesCount: number;
  createdAt: string;

  updatedAt: string;
  /**
   * A soft-deleted comment that still has live replies (decision J4). The
   * content is replaced and the author stripped, but the row is still rendered
   * so its replies do not become orphaned and unreachable.
   */
  isDeleted: boolean;
  /** Replies to this comment. Non-null only where a thread is expanded. */
  replyCount: number;
}

/** Mirrors the frontend's `CommentWithAuthor`. */
export interface CommentWithAuthorView extends CommentView {
  /** Null on a tombstone — a deleted comment discloses no author. */
  author: UserSummaryView | null;
}

/**
 * Viewer-relative state, so a reload can restore what the shipped UI currently
 * keeps only in `useState`. The direct analogue of `ProjectViewerState`.
 *
 * There is deliberately no field explaining *why* a post was visible.
 */
export interface PostViewerState {
  hasLiked: boolean;
  isBookmarked: boolean;
  votedOptionId: string | null;
  isAuthor: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

/** `GET /posts/:id` — the post plus the caller's relationship to it. */
export interface PostLookupResult {
  post: PostView;
  /** Null for anonymous viewers: there is no relationship to describe. */
  viewer: PostViewerState | null;
}

/**
 * The feed page shape.
 *
 * Deliberately `{ items, nextCursor, total }` rather than the offset
 * `pagination` envelope: the shipped `FeedList` drives `useInfiniteQuery` with
 * `getNextPageParam: (lastPage) => lastPage.nextCursor`, and the frontend
 * types this as `Paginated<T>` in `src/types/common.ts`.
 */
export interface FeedPage {
  items: PostView[];
  nextCursor: string | null;
  total: number;
}

export interface CommentPage {
  comments: CommentWithAuthorView[];
  nextCursor: string | null;
}
