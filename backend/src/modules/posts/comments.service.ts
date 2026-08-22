import { notificationPort } from "../../ports/notification.port.js";
import { AuditAction, recordAuditEvent, type AuditContext } from "../../utils/audit.js";
import { AppError } from "../../utils/errors.js";
import { buildCursorPage } from "../../utils/pagination.js";
import { toCommentView } from "./post.view.js";
import * as repo from "./posts.repository.js";
import {
  announceMentions,
  isAdmin,
  loadVisiblePost,
  type Actor,
  type Viewer,
} from "./posts.service.js";
import type {
  CreateCommentInput,
  CursorQuery,
  UpdateCommentInput,
} from "./posts.schema.js";
import type { CommentPage, CommentWithAuthorView } from "./posts.types.js";

/**
 * Comments (PRD §9, decisions J3 and J4).
 *
 * Every method enters through `loadVisiblePost`, which is what makes the
 * comment endpoints inherit the post's privacy rules for free: a private
 * post's thread 404s exactly as the post does, and a blocked viewer cannot
 * reach it through this side door.
 */

export async function list(
  postId: string,
  viewer: Viewer,
  query: CursorQuery,
): Promise<CommentPage> {
  await loadVisiblePost(postId, viewer);

  const rows = await repo.listComments(postId, query.cursor, query.limit);
  const page = buildCursorPage(rows, query.limit, (row) => row.id);

  return { comments: page.items.map(toCommentView), nextCursor: page.nextCursor };
}

/**
 * Replies to one comment. One level only — a reply can never itself have
 * replies, so this never recurses.
 */
export async function listReplies(
  commentId: string,
  viewer: Viewer,
  query: CursorQuery,
): Promise<CommentPage> {
  const parent = await repo.findComment(commentId);

  if (!parent) {
    throw AppError.notFound("Comment not found");
  }

  // The post's gate governs its whole thread.
  await loadVisiblePost(parent.postId, viewer);

  const rows = await repo.listReplies(commentId, query.cursor, query.limit);
  const page = buildCursorPage(rows, query.limit, (row) => row.id);

  return { comments: page.items.map(toCommentView), nextCursor: page.nextCursor };
}

/**
 * Creates a comment, or a reply to one.
 *
 * **Depth is capped at one** (decision J4): the shipped UI renders a flat
 * thread, DATABASE.md warns against an over-complicated comment architecture,
 * and an uncapped adjacency list is how comment threads become unrenderable.
 * A reply to a reply is a 422 that names the real parent, so a client can
 * retry against the thread root rather than guess.
 */
export async function create(
  postId: string,
  actor: Actor,
  input: CreateCommentInput,
): Promise<CommentWithAuthorView> {
  const post = await loadVisiblePost(postId, actor);

  const parentId = input.parentCommentId ?? null;
  let parentAuthorId: string | null = null;

  if (parentId !== null) {
    const parent = await repo.findComment(parentId);

    if (!parent || parent.postId !== postId) {
      throw AppError.notFound("Comment not found");
    }

    if (parent.parentCommentId !== null) {
      throw AppError.validation("Replies are only one level deep", [
        {
          field: "parentCommentId",
          message: `Reply to the top-level comment instead (${parent.parentCommentId}).`,
        },
      ]);
    }

    if (parent.deletedAt !== null) {
      throw AppError.validation("That comment was deleted", [
        { field: "parentCommentId", message: "You cannot reply to a deleted comment." },
      ]);
    }

    parentAuthorId = parent.authorId;
  }

  const row = await repo.createComment(postId, actor.id, input.content, parentId);

  // Notify the post author, and the parent comment's author on a reply. Both
  // go through the port; Phase 9 owns delivery.
  if (post.row.authorId !== actor.id) {
    await notificationPort.emit({
      recipientId: post.row.authorId,
      actorId: actor.id,
      type: "comment",
      entityType: "post",
      entityId: postId,
    });
  }

  if (parentAuthorId !== null && parentAuthorId !== actor.id) {
    await notificationPort.emit({
      recipientId: parentAuthorId,
      actorId: actor.id,
      type: "reply",
      entityType: "comment",
      entityId: row.id,
    });
  }

  await announceMentions(input.content, actor.id, row.id);

  return toCommentView(row);
}

/** Loads a comment and the gate of the post it belongs to. */
async function loadComment(commentId: string, viewer: Viewer) {
  const row = await repo.findComment(commentId);

  if (!row) {
    throw AppError.notFound("Comment not found");
  }

  await loadVisiblePost(row.postId, viewer);
  return row;
}

/**
 * Editing is **author-only** — not the post author, and not an admin.
 * Moderation removes content; it does not rewrite it in someone else's voice.
 */
export async function update(
  commentId: string,
  actor: Actor,
  input: UpdateCommentInput,
): Promise<CommentWithAuthorView> {
  const existing = await loadComment(commentId, actor);

  if (existing.deletedAt !== null) {
    throw AppError.notFound("Comment not found");
  }

  if (existing.authorId !== actor.id) {
    throw AppError.authorization("You can only edit your own comments");
  }

  const row = await repo.updateComment(commentId, input.content);
  await announceMentions(input.content, actor.id, commentId);

  return toCommentView(row);
}

/**
 * Soft-deletes a comment.
 *
 * Permitted to the comment's author, to the **post's** author (PRD §9
 * "Moderation" — someone must be able to clean up their own thread), and to
 * platform admins.
 *
 * The row survives so a deleted parent still renders as a tombstone carrying
 * its replies. `Comment.parent` cascades only on a *hard* delete, so dropping
 * the row from the response would leave its replies unreachable.
 */
export async function remove(
  commentId: string,
  actor: Actor,
  auditContext: AuditContext,
): Promise<{ deleted: boolean }> {
  const existing = await repo.findComment(commentId);

  if (!existing) {
    throw AppError.notFound("Comment not found");
  }

  const post = await loadVisiblePost(existing.postId, actor);

  const isCommentAuthor = existing.authorId === actor.id;
  const isPostAuthor = post.row.authorId === actor.id;

  if (!isCommentAuthor && !isPostAuthor && !isAdmin(actor.role)) {
    throw AppError.authorization("You cannot delete this comment");
  }

  const deleted = await repo.softDeleteComment(commentId, existing.postId);

  if (deleted) {
    await recordAuditEvent({
      ...auditContext,
      actorId: actor.id,
      action: AuditAction.COMMENT_DELETED,
      targetType: "comment",
      targetId: commentId,
      metadata: {
        postId: existing.postId,
        authorId: existing.authorId,
        byAuthor: isCommentAuthor,
      },
    });
  }

  return { deleted };
}
