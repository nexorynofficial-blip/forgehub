import type { Prisma, Visibility } from "@prisma/client";

import { prisma } from "../../database/prisma.js";
import { summarySelect } from "../users/users.repository.js";
import type { FeedFilterValue } from "./posts.schema.js";

/**
 * The only layer that touches Prisma for posts and their children
 * (BACKEND_ARCHITECTURE.md §4).
 *
 * Every counter here is an **atomic increment**, not a read-modify-write, so
 * unlike Phase 5's `progressPercent` none of them needs an explicit row lock —
 * the arbiter is always a unique index or composite primary key.
 *
 * `deletedAt` is selected because the visibility gate and the comment tombstone
 * rule both need it, and is never projected — see `post.view.ts`.
 */

/* ── Selects and row types ───────────────────────────────────────────────── */

/**
 * The full post payload.
 *
 * `media` is ordered by `position` because the frontend's `mediaUrls` is a flat
 * array rendered in sequence — the ordering contract lives in the response
 * order, exactly as it does for project milestones.
 */
const postDetailSelect = {
  id: true,
  authorId: true,
  projectId: true,
  /** Read for the visibility gate (decision J9). Never projected. */
  communityId: true,
  type: true,
  content: true,
  visibility: true,
  codeLanguage: true,
  codeContent: true,
  likesCount: true,
  commentsCount: true,
  createdAt: true,
  updatedAt: true,
  /** Read for the visibility gate. Never projected. */
  deletedAt: true,
  author: { select: summarySelect },
  media: {
    select: {
      url: true,
      type: true,
      position: true,
      width: true,
      height: true,
    },
    orderBy: { position: "asc" },
  },
  poll: {
    select: {
      id: true,
      question: true,
      closesAt: true,
      options: {
        select: { id: true, label: true, voteCount: true, position: true },
        orderBy: { position: "asc" },
      },
    },
  },
} satisfies Prisma.PostSelect;

export type PostDetailRow = Prisma.PostGetPayload<{ select: typeof postDetailSelect }>;

/**
 * A comment, with the reply count the tombstone rule needs.
 *
 * `_count.replies` is what lets a soft-deleted comment be rendered as a
 * tombstone rather than dropped (decision J4): a deleted parent with live
 * replies has to stay in the response, or its replies become orphaned and
 * unreachable.
 */
const commentSelect = {
  id: true,
  postId: true,
  authorId: true,
  parentCommentId: true,
  content: true,
  likesCount: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  author: { select: summarySelect },
  _count: { select: { replies: true } },
} satisfies Prisma.CommentSelect;

export type CommentRow = Prisma.CommentGetPayload<{ select: typeof commentSelect }>;

export { commentSelect, postDetailSelect };

/* ── Viewer-scoped filtering ─────────────────────────────────────────────── */

export interface RepoViewer {
  id: string | null;
  role: import("@prisma/client").UserRole | null;
}

/**
 * The feed/listing filter, expressed in SQL rather than applied after the fact.
 *
 * This must agree with `isPostListable` in `post.visibility.ts` branch for
 * branch. Filtering in the database *and* in a pure function is not
 * duplication for its own sake: the pure function is what the unit tests pin
 * the rules to, and this is what stops a hidden post consuming a page slot or
 * inflating a count. If the two disagreed, paging would return short pages.
 *
 * **Phase 7 seam.** Phase 6 decision J9 welded `communityId: null` here,
 * excluding every community post from every listing because no `Community`
 * existed to evaluate. Phase 7 replaces that with the real rule (decision J2):
 * a post either belongs to no community, or belongs to one that is **public
 * and not deleted**. Nothing else about this filter changed — a non-community
 * post takes exactly the branch it took before, since `communityId: null`
 * remains the first arm of the disjunction.
 *
 * Membership is deliberately *not* consulted here. The global feed carries
 * public-community posts only; a member reads their private community's posts
 * on the community page, which owns its own scoped listing. Widening this to
 * "public OR I am a member" would mix private-community content into
 * `following`, `trending`, and `popular_today` — the leak decision J2 exists to
 * prevent.
 */
const COMMUNITY_LISTABLE: Prisma.PostWhereInput[] = [
  { communityId: null },
  { community: { visibility: "public", deletedAt: null } },
];

function listVisibilityWhere(viewer: RepoViewer): Prisma.PostWhereInput {
  if (viewer.id === null) {
    return { deletedAt: null, visibility: "public", OR: COMMUNITY_LISTABLE };
  }

  return {
    deletedAt: null,
    // A post is invisible to a viewer its author has blocked (Phase 4 Block).
    author: { blocksMade: { none: { blockedId: viewer.id } } },
    // Two independent disjunctions — the community rule and the post-visibility
    // rule — combined under `AND` so neither silently replaces the other, which
    // is what a second `OR` key in one object literal would do.
    AND: [
      { OR: COMMUNITY_LISTABLE },
      { OR: [{ visibility: "public" }, { authorId: viewer.id }] },
    ],
  };
}

export { listVisibilityWhere };

/**
 * Feed ordering per filter (decision J5).
 *
 * Every key maps to an indexed column: `latest` and `popular_today` are served
 * by `posts(visibility, deletedAt, createdAt DESC)` and
 * `posts(deletedAt, likesCount DESC)`. An open sort parameter would let a
 * caller order by an unindexed column and turn the feed into a sequential scan.
 *
 * `recommended` uses comments-then-likes, which is exactly the heuristic the
 * shipped `feed-service.ts` applies for that filter. The weighted
 * `likes + 3*comments` form the frontend uses for `ai_recommended` is not
 * expressible in an indexed `orderBy` and would need a raw sort over the whole
 * table, so `ai_recommended` aliases this instead of approximating it badly.
 *
 * `id` is the final tiebreaker on every filter so cursor paging is stable —
 * without a unique last key, two posts with equal counts could straddle a page
 * boundary and be returned twice or skipped.
 */
function orderForFilter(filter: FeedFilterValue): Prisma.PostOrderByWithRelationInput[] {
  switch (filter) {
    case "trending":
    case "popular_today":
      return [{ likesCount: "desc" }, { createdAt: "desc" }, { id: "desc" }];
    case "recommended":
    case "ai_recommended":
      return [
        { commentsCount: "desc" },
        { likesCount: "desc" },
        { createdAt: "desc" },
        { id: "desc" },
      ];
    case "following":
    case "latest":
    default:
      return [{ createdAt: "desc" }, { id: "desc" }];
  }
}

/** `popular_today` is scoped to the last 24 hours; the others are not. */
const POPULAR_WINDOW_MS = 24 * 60 * 60 * 1000;

function filterWhere(filter: FeedFilterValue, viewer: RepoViewer): Prisma.PostWhereInput {
  if (filter === "popular_today") {
    return { createdAt: { gte: new Date(Date.now() - POPULAR_WINDOW_MS) } };
  }

  if (filter === "following") {
    // Anonymous callers follow nobody, so the filter is empty rather than
    // silently degrading to "latest".
    if (viewer.id === null) return { id: { in: [] } };

    // Expressed as a relation filter so the follows module stays untouched:
    // "authors whose followers include the viewer".
    return { author: { followers: { some: { followerId: viewer.id } } } };
  }

  return {};
}

function feedWhere(filter: FeedFilterValue, viewer: RepoViewer): Prisma.PostWhereInput {
  return { ...listVisibilityWhere(viewer), ...filterWhere(filter, viewer) };
}

/* ── Reads ──────────────────────────────────────────────────────────────── */

/**
 * Single post by id. Deliberately does **not** filter `deletedAt` — the gate
 * needs to distinguish "soft-deleted" from "never existed" internally, even
 * though both resolve to the same 404 for the caller.
 */
export async function findById(id: string): Promise<PostDetailRow | null> {
  return prisma.post.findUnique({ where: { id }, select: postDetailSelect });
}

export async function listFeed(
  viewer: RepoViewer,
  filter: FeedFilterValue,
  cursor: string | undefined,
  limit: number,
): Promise<{ rows: PostDetailRow[]; total: number }> {
  const where = feedWhere(filter, viewer);

  const [rows, total] = await Promise.all([
    prisma.post.findMany({
      where,
      select: postDetailSelect,
      orderBy: orderForFilter(filter),
      // Over-fetch by one: the extra row proves more data exists without a
      // second COUNT (see `utils/pagination.buildCursorPage`).
      take: limit + 1,
      ...(cursor !== undefined ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),
    prisma.post.count({ where }),
  ]);

  return { rows, total };
}

/** Backs the shipped "new posts" pill (decision J10). One indexed COUNT. */
export async function countNewSince(
  viewer: RepoViewer,
  filter: FeedFilterValue,
  since: Date,
): Promise<number> {
  return prisma.post.count({
    where: { ...feedWhere(filter, viewer), createdAt: { gt: since } },
  });
}

/** A profile's own posts. Honours the same visibility rules as the feed. */
export async function listByAuthor(
  authorId: string,
  viewer: RepoViewer,
  cursor: string | undefined,
  limit: number,
): Promise<PostDetailRow[]> {
  return prisma.post.findMany({
    where: { ...listVisibilityWhere(viewer), authorId },
    select: postDetailSelect,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor !== undefined ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}

/** The caller's own bookmarks, newest first — what the composite index serves. */
export async function listBookmarked(
  userId: string,
  cursor: string | undefined,
  limit: number,
): Promise<{ cursorId: string; post: PostDetailRow }[]> {
  const rows = await prisma.bookmark.findMany({
    where: { userId, post: { deletedAt: null } },
    select: { postId: true, post: { select: postDetailSelect } },
    orderBy: [{ createdAt: "desc" }, { postId: "desc" }],
    take: limit + 1,
    ...(cursor !== undefined
      ? { cursor: { postId_userId: { postId: cursor, userId } }, skip: 1 }
      : {}),
  });

  return rows.map((row) => ({ cursorId: row.postId, post: row.post }));
}

/**
 * Top-level comments on a post, oldest first.
 *
 * Soft-deleted comments are **kept** when they still have replies (decision
 * J4) — dropping a deleted parent would leave its replies unreachable. A
 * deleted comment with no replies is filtered out entirely, since nothing
 * depends on it.
 */
export async function listComments(
  postId: string,
  cursor: string | undefined,
  limit: number,
): Promise<CommentRow[]> {
  return prisma.comment.findMany({
    where: {
      postId,
      parentCommentId: null,
      OR: [{ deletedAt: null }, { replies: { some: {} } }],
    },
    select: commentSelect,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    ...(cursor !== undefined ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}

/** One level of replies. A reply can never itself have replies (decision J4). */
export async function listReplies(
  parentCommentId: string,
  cursor: string | undefined,
  limit: number,
): Promise<CommentRow[]> {
  return prisma.comment.findMany({
    where: { parentCommentId, deletedAt: null },
    select: commentSelect,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    ...(cursor !== undefined ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}

export async function findComment(id: string): Promise<CommentRow | null> {
  return prisma.comment.findUnique({ where: { id }, select: commentSelect });
}

export async function hasLikedPost(postId: string, userId: string): Promise<boolean> {
  const row = await prisma.postLike.findUnique({
    where: { postId_userId: { postId, userId } },
    select: { postId: true },
  });
  return row !== null;
}

export async function hasLikedComment(
  commentId: string,
  userId: string,
): Promise<boolean> {
  const row = await prisma.commentLike.findUnique({
    where: { commentId_userId: { commentId, userId } },
    select: { commentId: true },
  });
  return row !== null;
}

export async function isBookmarked(postId: string, userId: string): Promise<boolean> {
  const row = await prisma.bookmark.findUnique({
    where: { postId_userId: { postId, userId } },
    select: { postId: true },
  });
  return row !== null;
}

/** Which option this viewer picked in a poll, if any. */
export async function findVotedOptionId(
  pollId: string,
  userId: string,
): Promise<string | null> {
  const row = await prisma.pollVote.findUnique({
    where: { pollId_userId: { pollId, userId } },
    select: { optionId: true },
  });
  return row?.optionId ?? null;
}

/** Resolves handles to ids for mention notification (decision J6). */
export async function findUserIdsByUsernames(
  usernames: string[],
): Promise<{ id: string; username: string }[]> {
  if (usernames.length === 0) return [];

  return prisma.user.findMany({
    where: { username: { in: usernames }, deletedAt: null },
    select: { id: true, username: true },
  });
}

/** Confirms a project exists and is readable, for optional attribution (J8). */
export async function findProjectOwner(
  projectId: string,
): Promise<{ ownerId: string; visibility: string; deletedAt: Date | null } | null> {
  return prisma.project.findUnique({
    where: { id: projectId },
    select: { ownerId: true, visibility: true, deletedAt: true },
  });
}

/* ── Post writes ────────────────────────────────────────────────────────── */

export interface CreatePostData {
  authorId: string;
  type: import("@prisma/client").PostType;
  content: string;
  visibility: import("@prisma/client").Visibility;
  projectId: string | null;
  /**
   * Phase 7 (decision J3). Supplied only by the community post route, which
   * derives it from the resolved community — never from a request body, and
   * `createPostSchema` still has no such field. Null for an ordinary post.
   */
  communityId?: string | null;
  codeLanguage: string | null;
  codeContent: string | null;
  media: {
    url: string;
    type: import("@prisma/client").MediaType;
    width?: number;
    height?: number;
  }[];
  poll: { question: string; closesAt: Date | null; options: string[] } | null;
}

/**
 * Creates a post with its media and poll in one transaction.
 *
 * `communityId` is deliberately not settable (decision J9): a post whose
 * audience this phase cannot compute must not be creatable through it.
 */
export async function createPost(data: CreatePostData): Promise<PostDetailRow> {
  return prisma.$transaction(async (tx) => {
    const created = await tx.post.create({
      data: {
        authorId: data.authorId,
        type: data.type,
        content: data.content,
        visibility: data.visibility,
        projectId: data.projectId,
        // Phase 7: null unless the community post route supplied it.
        communityId: data.communityId ?? null,
        codeLanguage: data.codeLanguage,
        codeContent: data.codeContent,
        ...(data.media.length > 0
          ? {
              media: {
                create: data.media.map((item, index) => ({
                  url: item.url,
                  type: item.type,
                  position: index,
                  ...(item.width !== undefined ? { width: item.width } : {}),
                  ...(item.height !== undefined ? { height: item.height } : {}),
                })),
              },
            }
          : {}),
        ...(data.poll !== null
          ? {
              poll: {
                create: {
                  question: data.poll.question,
                  closesAt: data.poll.closesAt,
                  options: {
                    create: data.poll.options.map((label, index) => ({
                      label,
                      position: index,
                    })),
                  },
                },
              },
            }
          : {}),
      },
      select: { id: true },
    });

    return tx.post.findUniqueOrThrow({
      where: { id: created.id },
      select: postDetailSelect,
    });
  });
}

export interface UpdatePostData {
  content?: string | undefined;
  visibility?: import("@prisma/client").Visibility | undefined;
  codeLanguage?: string | null | undefined;
  codeContent?: string | null | undefined;
  media?:
    | {
        url: string;
        type: import("@prisma/client").MediaType;
        width?: number;
        height?: number;
      }[]
    | undefined;
}

/**
 * Applies a patch. Media is a **replace set**, not a merge: the client submits
 * the complete list it knows about, so a merge would make removing an image
 * impossible — the same semantics Phase 4 chose for social links.
 */
export async function updatePost(
  postId: string,
  data: UpdatePostData,
): Promise<PostDetailRow> {
  return prisma.$transaction(async (tx) => {
    const patch: Prisma.PostUpdateInput = {};
    if (data.content !== undefined) patch.content = data.content;
    if (data.visibility !== undefined) patch.visibility = data.visibility;
    if (data.codeLanguage !== undefined) patch.codeLanguage = data.codeLanguage;
    if (data.codeContent !== undefined) patch.codeContent = data.codeContent;

    if (Object.keys(patch).length > 0) {
      await tx.post.update({ where: { id: postId }, data: patch });
    }

    if (data.media !== undefined) {
      await tx.postMedia.deleteMany({ where: { postId } });
      if (data.media.length > 0) {
        await tx.postMedia.createMany({
          data: data.media.map((item, index) => ({
            postId,
            url: item.url,
            type: item.type,
            position: index,
            ...(item.width !== undefined ? { width: item.width } : {}),
            ...(item.height !== undefined ? { height: item.height } : {}),
          })),
        });
      }
    }

    return tx.post.findUniqueOrThrow({ where: { id: postId }, select: postDetailSelect });
  });
}

/**
 * Soft delete. The `deletedAt: null` guard makes a repeated delete a no-op
 * rather than a second state change — the same discipline that keeps counters
 * honest elsewhere.
 */
export async function softDeletePost(postId: string): Promise<boolean> {
  const removed = await prisma.post.updateMany({
    where: { id: postId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  return removed.count > 0;
}

/* ── Comment writes ─────────────────────────────────────────────────────── */

/**
 * Creates a comment and moves `Post.commentsCount` in one transaction.
 *
 * The count includes replies and excludes soft-deleted rows, which is exactly
 * how `prisma/seed.ts` recomputes it. Diverging would make the seed's own
 * counters disagree with the API.
 */
export async function createComment(
  postId: string,
  authorId: string,
  content: string,
  parentCommentId: string | null,
): Promise<CommentRow> {
  return prisma.$transaction(async (tx) => {
    const created = await tx.comment.create({
      data: { postId, authorId, content, parentCommentId },
      select: { id: true },
    });

    await tx.post.update({
      where: { id: postId },
      data: { commentsCount: { increment: 1 } },
    });

    return tx.comment.findUniqueOrThrow({
      where: { id: created.id },
      select: commentSelect,
    });
  });
}

export async function updateComment(
  commentId: string,
  content: string,
): Promise<CommentRow> {
  return prisma.comment.update({
    where: { id: commentId },
    data: { content },
    select: commentSelect,
  });
}

/**
 * Soft-deletes a comment and decrements the post's counter.
 *
 * The row survives so a deleted parent can still be rendered as a tombstone
 * carrying its replies (decision J4). The decrement is gated on a row actually
 * changing, so a repeated delete cannot drive `commentsCount` negative.
 */
export async function softDeleteComment(
  commentId: string,
  postId: string,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const removed = await tx.comment.updateMany({
      where: { id: commentId, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    if (removed.count === 0) return false;

    await tx.post.update({
      where: { id: postId },
      data: { commentsCount: { decrement: removed.count } },
    });
    return true;
  });
}

/* ── Engagement ─────────────────────────────────────────────────────────── */

/**
 * Likes and bookmarks share the Phase 4/5 shape:
 *
 *   - The **composite primary key is the arbiter.** Simultaneous identical
 *     likes all attempt the insert; exactly one commits and the rest raise
 *     `P2002` and roll back, including their counter increments.
 *   - **`{ increment: 1 }` compiles to `SET x = x + 1`** under a row lock, so
 *     two *different* likers serialize instead of losing an update.
 *   - **Decrements gate on a row actually being deleted**, which is what lets
 *     unlike be idempotent without driving the counter negative.
 */
export async function likePost(postId: string, userId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.postLike.create({ data: { postId, userId } });
    await tx.post.update({
      where: { id: postId },
      data: { likesCount: { increment: 1 } },
    });
  });
}

export async function unlikePost(postId: string, userId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const removed = await tx.postLike.deleteMany({ where: { postId, userId } });
    if (removed.count === 0) return false;

    await tx.post.update({
      where: { id: postId },
      data: { likesCount: { decrement: removed.count } },
    });
    return true;
  });
}

export async function likeComment(commentId: string, userId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.commentLike.create({ data: { commentId, userId } });
    await tx.comment.update({
      where: { id: commentId },
      data: { likesCount: { increment: 1 } },
    });
  });
}

export async function unlikeComment(commentId: string, userId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const removed = await tx.commentLike.deleteMany({ where: { commentId, userId } });
    if (removed.count === 0) return false;

    await tx.comment.update({
      where: { id: commentId },
      data: { likesCount: { decrement: removed.count } },
    });
    return true;
  });
}

/** Bookmarks carry no counter — there is no `bookmarksCount` column. */
export async function addBookmark(postId: string, userId: string): Promise<void> {
  await prisma.bookmark.create({ data: { postId, userId } });
}

export async function removeBookmark(postId: string, userId: string): Promise<boolean> {
  const removed = await prisma.bookmark.deleteMany({ where: { postId, userId } });
  return removed.count > 0;
}

/* ── Poll voting ────────────────────────────────────────────────────────── */

/**
 * Records a vote and moves the option's tally in one transaction.
 *
 * The arbiter is `@@unique([pollId, userId])` — note it is on the *poll*, not
 * the option, so a user who fires two simultaneous votes for two different
 * options gets exactly one recorded and one `P2002`. Without the increment
 * living inside this transaction, the losing vote would still have inflated a
 * tally.
 *
 * Votes are final: there is no update path, matching `PollVoter`, which
 * disables itself once a choice is made.
 */
export async function castVote(
  pollId: string,
  optionId: string,
  userId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.pollVote.create({ data: { pollId, optionId, userId } });
    await tx.pollOption.update({
      where: { id: optionId },
      data: { voteCount: { increment: 1 } },
    });
  });
}

/** Resolves an option to its poll, and reports whether voting has closed. */
export async function findOption(
  optionId: string,
): Promise<{ pollId: string; postId: string; closesAt: Date | null } | null> {
  const row = await prisma.pollOption.findUnique({
    where: { id: optionId },
    select: { pollId: true, poll: { select: { postId: true, closesAt: true } } },
  });

  if (!row) return null;
  return { pollId: row.pollId, postId: row.poll.postId, closesAt: row.poll.closesAt };
}

/** Counter read used by the engagement responses and by the tests. */
export async function readPostCounters(
  postId: string,
): Promise<{ likesCount: number; commentsCount: number } | null> {
  return prisma.post.findUnique({
    where: { id: postId },
    select: { likesCount: true, commentsCount: true },
  });
}

/**
 * Which option the viewer chose across many polls, in one query.
 *
 * The batch form exists so a feed page of poll posts costs one round trip
 * rather than one per post — the N+1 BACKEND_TRD.md §38 forbids.
 */
export async function findVotesForPolls(
  pollIds: string[],
  userId: string,
): Promise<Map<string, string>> {
  if (pollIds.length === 0) return new Map();

  const rows = await prisma.pollVote.findMany({
    where: { pollId: { in: pollIds }, userId },
    select: { pollId: true, optionId: true },
  });

  return new Map(rows.map((row) => [row.pollId, row.optionId]));
}

/**
 * Of these post ids, which are still live (not soft-deleted).
 *
 * Added in Phase 7 for the community pin list: a pin is only a reference, and a
 * post that was pinned and later deleted must drop out of the list rather than
 * be resurrected by the join. Additive — no Phase 6 caller is affected.
 */
export async function findLiveIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();

  const rows = await prisma.post.findMany({
    where: { id: { in: ids }, deletedAt: null },
    select: { id: true },
  });

  return new Set(rows.map((row) => row.id));
}

/* ── Phase 7 seam (decision J2) ──────────────────────────────────────────── */

/**
 * The community's visibility and delete state, for the post visibility gate.
 *
 * Added in Phase 7. Reads the `Community` table directly rather than calling
 * into the communities module, keeping the dependency one-way: the older,
 * closed posts module must not import a sibling service that itself reads
 * posts, which would be a cycle.
 */
export async function findCommunityStanding(
  communityId: string,
): Promise<{ visibility: Visibility; deletedAt: Date | null } | null> {
  return prisma.community.findUnique({
    where: { id: communityId },
    select: { visibility: true, deletedAt: true },
  });
}

/** Whether the viewer holds a membership row in that community. */
export async function findCommunityMembership(
  communityId: string,
  userId: string,
): Promise<boolean> {
  const row = await prisma.communityMember.findUnique({
    where: { communityId_userId: { communityId, userId } },
    select: { userId: true },
  });
  return row !== null;
}

/**
 * Posts belonging to one community, cursor-paginated.
 *
 * Deliberately **not** routed through `listVisibilityWhere`: that filter serves
 * the *global* feed and admits only public communities, which would return an
 * empty page for the private community whose own page is being rendered. The
 * community's visibility is settled by the caller's gate before this runs, so
 * what remains here is the post-level rule — soft deletes, blocked authors, and
 * the author's own private posts.
 */
export async function listCommunityPosts(
  communityId: string,
  viewer: RepoViewer,
  cursor: string | undefined,
  take: number,
): Promise<PostDetailRow[]> {
  const where: Prisma.PostWhereInput =
    viewer.id === null
      ? { communityId, deletedAt: null, visibility: "public" }
      : {
          communityId,
          deletedAt: null,
          author: { blocksMade: { none: { blockedId: viewer.id } } },
          OR: [{ visibility: "public" }, { authorId: viewer.id }],
        };

  return prisma.post.findMany({
    where,
    select: postDetailSelect,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    ...(cursor !== undefined ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}

/** Creates a post inside a community. `communityId` is never client-supplied. */
export async function createCommunityPost(
  data: CreatePostData & { communityId: string },
): Promise<PostDetailRow> {
  return createPost(data);
}
