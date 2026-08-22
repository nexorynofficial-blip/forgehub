import { notificationPort } from "../../ports/notification.port.js";
import { AppError } from "../../utils/errors.js";
import * as repo from "./posts.repository.js";
import { isUniqueViolation, loadVisiblePost, type Actor } from "./posts.service.js";

/**
 * Likes, comment likes, bookmarks, and poll votes.
 *
 * All of them enter through `loadVisiblePost`, so a post a viewer cannot see is
 * also a post they cannot like, bookmark, or vote on — the gate is not just a
 * read concern.
 *
 * Liking your own post is allowed, matching the projects module: self-following
 * a *user* is a meaningless self-referential edge, but liking your own content
 * is ordinary behaviour and nothing downstream divides by it.
 */

export interface EngagementResult {
  liked?: boolean;
  bookmarked?: boolean;
  likesCount: number;
}

async function likesOf(postId: string): Promise<number> {
  const counters = await repo.readPostCounters(postId);
  return counters?.likesCount ?? 0;
}

/* ── Post likes ─────────────────────────────────────────────────────────── */

export async function likePost(postId: string, actor: Actor): Promise<EngagementResult> {
  const context = await loadVisiblePost(postId, actor);

  try {
    await repo.likePost(postId, actor.id);
  } catch (error) {
    // The composite primary key is the arbiter under concurrency; this turns
    // the loser of that race into a clean 409 rather than a 500.
    if (isUniqueViolation(error)) {
      throw AppError.conflict("You have already liked this post");
    }
    throw error;
  }

  if (context.row.authorId !== actor.id) {
    await notificationPort.emit({
      recipientId: context.row.authorId,
      actorId: actor.id,
      type: "like",
      entityType: "post",
      entityId: postId,
    });
  }

  return { liked: true, likesCount: await likesOf(postId) };
}

/** Idempotent: unliking something never liked is a success, not a 404. */
export async function unlikePost(
  postId: string,
  actor: Actor,
): Promise<EngagementResult> {
  await loadVisiblePost(postId, actor);
  await repo.unlikePost(postId, actor.id);

  return { liked: false, likesCount: await likesOf(postId) };
}

/* ── Comment likes ──────────────────────────────────────────────────────── */

export async function likeComment(
  commentId: string,
  actor: Actor,
): Promise<{ liked: boolean; likesCount: number }> {
  const comment = await repo.findComment(commentId);

  if (!comment || comment.deletedAt !== null) {
    throw AppError.notFound("Comment not found");
  }

  await loadVisiblePost(comment.postId, actor);

  try {
    await repo.likeComment(commentId, actor.id);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw AppError.conflict("You have already liked this comment");
    }
    throw error;
  }

  const updated = await repo.findComment(commentId);
  return { liked: true, likesCount: updated?.likesCount ?? 0 };
}

export async function unlikeComment(
  commentId: string,
  actor: Actor,
): Promise<{ liked: boolean; likesCount: number }> {
  const comment = await repo.findComment(commentId);

  if (!comment) {
    throw AppError.notFound("Comment not found");
  }

  await loadVisiblePost(comment.postId, actor);
  await repo.unlikeComment(commentId, actor.id);

  const updated = await repo.findComment(commentId);
  return { liked: false, likesCount: updated?.likesCount ?? 0 };
}

/* ── Bookmarks ──────────────────────────────────────────────────────────── */

/**
 * Bookmarks are private and carry no counter — there is no `bookmarksCount`
 * column, and a public tally would turn a private save into a signal.
 */
export async function addBookmark(
  postId: string,
  actor: Actor,
): Promise<{ bookmarked: boolean }> {
  await loadVisiblePost(postId, actor);

  try {
    await repo.addBookmark(postId, actor.id);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw AppError.conflict("You have already bookmarked this post");
    }
    throw error;
  }

  return { bookmarked: true };
}

export async function removeBookmark(
  postId: string,
  actor: Actor,
): Promise<{ bookmarked: boolean }> {
  await loadVisiblePost(postId, actor);
  await repo.removeBookmark(postId, actor.id);

  return { bookmarked: false };
}

/* ── Poll voting ────────────────────────────────────────────────────────── */

/**
 * Casts a vote.
 *
 * The client names an **option**, because the frontend's `Poll` type carries no
 * id and `PollVoter` has only `option.id` in hand. The server resolves the poll
 * from it and checks that the option really belongs to the post being voted on
 * — otherwise an option id from another poll would let a caller vote on a poll
 * they cannot see.
 *
 * Votes are final. `@@unique([pollId, userId])` is on the *poll*, so a second
 * vote — even for a different option — is a 409, which is exactly what the
 * shipped `PollVoter` expects when it disables itself after one choice.
 */
export async function vote(
  postId: string,
  optionId: string,
  actor: Actor,
): Promise<{ votedOptionId: string; options: { id: string; voteCount: number }[] }> {
  const context = await loadVisiblePost(postId, actor);
  const option = await repo.findOption(optionId);

  if (!option || option.postId !== postId) {
    throw AppError.notFound("Poll option not found");
  }

  if (option.closesAt !== null && option.closesAt.getTime() <= Date.now()) {
    throw AppError.validation("This poll has closed", [
      { field: "optionId", message: "Voting closed on this poll." },
    ]);
  }

  try {
    await repo.castVote(option.pollId, optionId, actor.id);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw AppError.conflict("You have already voted in this poll");
    }
    throw error;
  }

  const refreshed = await repo.findById(context.row.id);
  const options = (refreshed?.poll?.options ?? []).map((o) => ({
    id: o.id,
    voteCount: o.voteCount,
  }));

  return { votedOptionId: optionId, options };
}
