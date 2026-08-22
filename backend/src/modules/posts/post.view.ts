import { toUserSummary } from "../users/user.view.js";
import type { CommentRow, PostDetailRow } from "./posts.repository.js";
import type {
  CodeSnippetView,
  CommentWithAuthorView,
  PollView,
  PostMediaView,
  PostView,
} from "./posts.types.js";

/**
 * The projection layer for posts and comments.
 *
 * Nothing outside this file turns a Prisma row into an API response — the same
 * chokepoint discipline as `users/user.view.ts` and `projects/project.view.ts`.
 *
 * Three columns are selected by the repository and deliberately never appear
 * here:
 *
 *   - **`deletedAt`** — read by the visibility gate. Emitting it would let a
 *     client distinguish "soft-deleted" from "never existed", which is exactly
 *     the distinction the 404 exists to erase.
 *   - **`communityId`** — read by the gate (decision J9). Exposing it would
 *     invite clients to depend on a linkage this phase cannot enforce.
 *   - **the author of a tombstoned comment** — a deleted comment discloses no
 *     author, only that something was there.
 *
 * Every projection is built **by construction**. None starts from a row and
 * deletes keys: an omission list starts leaking the day someone adds a column.
 */

function toIso(value: Date): string {
  return value.toISOString();
}

function toIsoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/* ── Post sub-shapes ─────────────────────────────────────────────────────── */

function toMedia(row: PostDetailRow): PostMediaView[] {
  return row.media.map((item) => ({
    url: item.url,
    type: item.type,
    position: item.position,
    width: item.width,
    height: item.height,
  }));
}

/**
 * The frontend's `CodeSnippet`, reassembled from the two columns Phase 2 chose
 * over a child table. Null unless both halves are present — a language with no
 * code is not a snippet.
 */
function toCodeSnippet(row: PostDetailRow): CodeSnippetView | null {
  if (row.codeLanguage === null || row.codeContent === null) return null;
  return { language: row.codeLanguage, code: row.codeContent };
}

/**
 * The frontend's `Poll`, which carries no `id` of its own and votes by
 * `option.id`. `id`, `votedOptionId`, and `isClosed` are additive.
 *
 * `votedOptionId` is a required parameter rather than an option with a default
 * — a caller must decide what this viewer voted for, and forgetting is a
 * compile error rather than a silent "nobody has voted".
 */
function toPoll(row: PostDetailRow, votedOptionId: string | null): PollView | null {
  if (row.poll === null) return null;

  return {
    question: row.poll.question,
    options: row.poll.options.map((option) => ({
      id: option.id,
      label: option.label,
      voteCount: option.voteCount,
    })),
    closesAt: toIsoOrNull(row.poll.closesAt),
    id: row.poll.id,
    votedOptionId,
    isClosed: row.poll.closesAt !== null && row.poll.closesAt.getTime() <= Date.now(),
  };
}

/* ── The post ────────────────────────────────────────────────────────────── */

/**
 * The full post, mirroring the shipped frontend's `Post` plus `author`
 * (its `PostWithAuthor`).
 *
 * `votedOptionId` is required for the same reason `toUserView`'s `includeEmail`
 * is: the viewer-specific decision must be made explicitly at the call site.
 */
export function toPostView(row: PostDetailRow, votedOptionId: string | null): PostView {
  return {
    id: row.id,
    authorId: row.authorId,
    projectId: row.projectId,
    type: row.type,
    content: row.content,
    mediaUrls: row.media.map((item) => item.url),
    codeSnippet: toCodeSnippet(row),
    poll: toPoll(row, votedOptionId),
    likesCount: row.likesCount,
    commentsCount: row.commentsCount,
    createdAt: toIso(row.createdAt),

    visibility: row.visibility,
    updatedAt: toIso(row.updatedAt),
    media: toMedia(row),
    author: toUserSummary(row.author),
  };
}

/* ── Comments ────────────────────────────────────────────────────────────── */

/** What a soft-deleted comment says in place of its content (decision J4). */
export const TOMBSTONE_CONTENT = "[deleted]";

/**
 * A comment, or a tombstone when it has been soft-deleted.
 *
 * A deleted comment is not dropped from the thread, because
 * `Comment.parent` cascades only on a *hard* delete — soft-deleting a parent
 * leaves its replies in place, and removing it from the response would make
 * them unreachable children of a comment that no longer appears.
 *
 * The tombstone is built by construction, not by blanking fields on a full
 * view: content is replaced, the author is dropped entirely, and the like
 * count is zeroed so a deleted comment cannot keep accruing visible signal.
 */
export function toCommentView(row: CommentRow): CommentWithAuthorView {
  const isDeleted = row.deletedAt !== null;

  if (isDeleted) {
    return {
      id: row.id,
      postId: row.postId,
      authorId: "",
      parentCommentId: row.parentCommentId,
      content: TOMBSTONE_CONTENT,
      likesCount: 0,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
      isDeleted: true,
      replyCount: row._count.replies,
      author: null,
    };
  }

  return {
    id: row.id,
    postId: row.postId,
    authorId: row.authorId,
    parentCommentId: row.parentCommentId,
    content: row.content,
    likesCount: row.likesCount,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    isDeleted: false,
    replyCount: row._count.replies,
    author: toUserSummary(row.author),
  };
}
