import type {
  CommentWithAuthor,
  FeedFilter,
  Paginated,
  PostAuthor,
  PostType,
  PostWithAuthor,
} from "@/types";
import { mockCommentsByPostId } from "@/lib/mock/comments";
import { mockFollowedAuthorIds, mockPosts } from "@/lib/mock/posts";

const PAGE_SIZE = 8;

/** No real ranking algorithm exists (TRD.md §5's Feed/Recommendation APIs
 * aren't implemented) — each filter just sorts the same mock pool by a
 * different heuristic. See docs/ASSUMPTIONS.md (Phase 06). */
function sortForFilter(posts: PostWithAuthor[], filter: FeedFilter): PostWithAuthor[] {
  const sorted = [...posts];
  switch (filter) {
    case "latest":
      return sorted.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    case "trending":
    case "popular_today":
      return sorted.sort((a, b) => b.likesCount - a.likesCount);
    case "following":
      return sorted
        .filter((post) => mockFollowedAuthorIds.has(post.authorId))
        .sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
    case "recommended":
      return sorted.sort((a, b) => b.commentsCount - a.commentsCount);
    case "ai_recommended":
      return sorted.sort(
        (a, b) =>
          b.likesCount + b.commentsCount * 3 - (a.likesCount + a.commentsCount * 3),
      );
    default:
      return sorted;
  }
}

/** Placeholder for the Feed API (TRD.md §5). `extraPosts` lets the composer
 * prepend a freshly-created post ahead of the mock pool without mutating it. */
export async function getFeedPage({
  filter,
  cursor,
  extraPosts = [],
}: {
  filter: FeedFilter;
  cursor: string | null;
  extraPosts?: PostWithAuthor[];
}): Promise<Paginated<PostWithAuthor>> {
  const pool = sortForFilter([...extraPosts, ...mockPosts], filter);
  const start = cursor ? Number(cursor) : 0;
  const page = pool.slice(start, start + PAGE_SIZE);
  const nextStart = start + PAGE_SIZE;

  return {
    items: page,
    nextCursor: nextStart < pool.length ? String(nextStart) : null,
    total: pool.length,
  };
}

export async function getCommentsForPost(postId: string): Promise<CommentWithAuthor[]> {
  return mockCommentsByPostId[postId] ?? [];
}

export async function addComment(
  postId: string,
  content: string,
  author: PostAuthor,
): Promise<CommentWithAuthor> {
  const comment: CommentWithAuthor = {
    id: crypto.randomUUID(),
    postId,
    authorId: author.id,
    author,
    parentCommentId: null,
    content,
    likesCount: 0,
    createdAt: new Date().toISOString(),
  };
  mockCommentsByPostId[postId] = [...(mockCommentsByPostId[postId] ?? []), comment];
  return comment;
}

export async function createPost({
  content,
  type,
  author,
}: {
  content: string;
  type: PostType;
  author: PostAuthor;
}): Promise<PostWithAuthor> {
  return {
    id: crypto.randomUUID(),
    authorId: author.id,
    author,
    projectId: null,
    type,
    content,
    mediaUrls: [],
    codeSnippet: null,
    poll: null,
    likesCount: 0,
    commentsCount: 0,
    createdAt: new Date().toISOString(),
  };
}

let pollCount = 0;

/** UI_UX.md §10 "Auto Refresh". Simulates discovering new posts on a poll
 * interval — a real implementation would compare against the newest known
 * post id/timestamp server-side, or push over the Phase 09 WebSocket
 * connection. Returns a small nonzero count once so `NewPostsPill` has
 * something to demonstrate, then goes quiet again. */
export async function checkForNewPosts(): Promise<number> {
  pollCount += 1;
  return pollCount === 3 ? 2 : 0;
}
