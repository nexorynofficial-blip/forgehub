import { AppError } from "../../utils/errors.js";
import * as postsRepo from "../posts/posts.repository.js";
import { toCommunityEventDetail, toCommunityView } from "./community.view.js";
import * as repo from "./communities.repository.js";
import type { CreateEventInput, UpdateEventInput } from "./communities.schema.js";
import {
  assertCan,
  loadVisibleCommunity,
  type Actor,
  type Viewer,
} from "./communities.service.js";
import type { CommunityEventDetailView, CommunityView } from "./communities.types.js";

/**
 * Community-owned resources: rules, tags, events, and pinned posts
 * (decisions J8, J10, J11, J14).
 *
 * Grouped into one service the way Phase 5 grouped milestones and updates:
 * each is a small child collection whose only authorization question is "may
 * this caller manage it", answered by the same access table, and every one of
 * them enters through `loadVisibleCommunity` so the block and visibility rules
 * reach them without restatement.
 */

/* ── Rules (decision J11) ────────────────────────────────────────────────── */

/**
 * Replaces the whole ordered rule list.
 *
 * Replace-set rather than per-rule CRUD because the frontend contract is a flat
 * `string[]`: a client holding only strings has no id to address one rule with.
 * The array index becomes `position`, so the submitted order *is* the stored
 * order, and the repository does the delete-and-insert in one transaction —
 * a reader never sees a half-replaced charter.
 *
 * `manage_rules` is admin-and-above: a community's rules are its constitution,
 * and a moderator running day-to-day operations does not get to rewrite it.
 */
export async function replaceRules(
  slug: string,
  actor: Actor,
  rules: string[],
): Promise<CommunityView> {
  const context = await loadVisibleCommunity(slug, actor);
  assertCan("manage_rules", context, "You cannot change this community's rules");

  const row = await repo.replaceRules(context.row.id, rules);
  return toCommunityView(row);
}

/* ── Tags (decision J8) ──────────────────────────────────────────────────── */

/**
 * Replaces the tag set.
 *
 * Unknown references are a 422 rather than a silent drop or an implicit
 * create: a client that asked for three tags and got two back has been lied
 * to, and letting any authenticated user mint taxonomy rows would make the
 * shared `Tag` table unbounded. Phase 10 owns search and free-text tagging.
 *
 * The counter arithmetic lives in the repository, where the delta is computed
 * and applied in the same transaction as the link rows — and where the
 * `usageCount > 0` guard keeps the counter shared with `ProjectTag` from ever
 * going negative.
 */
export async function replaceTags(
  slug: string,
  actor: Actor,
  refs: string[],
): Promise<CommunityView> {
  const context = await loadVisibleCommunity(slug, actor);
  assertCan("edit_community", context, "You cannot change this community's tags");

  const { found, missing } = await repo.resolveTags(refs);

  if (missing.length > 0) {
    throw AppError.validation("Unknown tags", [
      { field: "tags", message: `Unknown tags: ${missing.join(", ")}` },
    ]);
  }

  // De-duplicated before it reaches the delta computation: two references that
  // resolve to the same tag ("Open Source" and "open-source") must not be able
  // to increment the shared counter twice for one link row.
  const tagIds = [...new Set(found.map((tag) => tag.id))];

  const row = await repo.replaceTags(context.row.id, tagIds);
  return toCommunityView(row);
}

/* ── Events (decision J10) ───────────────────────────────────────────────── */

/**
 * Upcoming events.
 *
 * Readable by anyone who can see the community; the gate has already settled
 * that. `includePast` exists because a moderator editing the calendar needs to
 * see what has already happened, while the public widget does not.
 */
export async function listEvents(
  slug: string,
  viewer: Viewer,
  includePast: boolean,
  limit: number,
): Promise<CommunityEventDetailView[]> {
  const context = await loadVisibleCommunity(slug, viewer);
  const rows = await repo.listEvents(context.row.id, includePast, limit);

  return rows.map(toCommunityEventDetail);
}

export async function createEvent(
  slug: string,
  actor: Actor,
  input: CreateEventInput,
): Promise<CommunityEventDetailView> {
  const context = await loadVisibleCommunity(slug, actor);
  assertCan("manage_events", context, "You cannot manage this community's events");

  const row = await repo.createEvent({
    communityId: context.row.id,
    title: input.title,
    description: input.description ?? "",
    startsAt: input.startsAt,
    endsAt: input.endsAt ?? null,
    isOnline: input.isOnline ?? true,
    location: input.location ?? null,
  });

  return toCommunityEventDetail(row);
}

/**
 * Patches an event.
 *
 * The start/end ordering is re-checked here rather than only in the schema,
 * because a patch that moves *only* `startsAt` has to be validated against the
 * **stored** `endsAt` — information the schema does not have. Without this, a
 * one-field patch could quietly invert an event.
 */
export async function updateEvent(
  slug: string,
  eventId: string,
  actor: Actor,
  input: UpdateEventInput,
): Promise<CommunityEventDetailView> {
  const context = await loadVisibleCommunity(slug, actor);
  assertCan("manage_events", context, "You cannot manage this community's events");

  const existing = await repo.findEvent(context.row.id, eventId);
  if (existing === null) {
    throw AppError.notFound("Event not found");
  }

  const startsAt = input.startsAt ?? existing.startsAt;
  const endsAt = input.endsAt !== undefined ? input.endsAt : existing.endsAt;

  if (endsAt !== null && endsAt.getTime() < startsAt.getTime()) {
    throw AppError.validation("The event cannot end before it starts", [
      { field: "endsAt", message: "The event cannot end before it starts" },
    ]);
  }

  const row = await repo.updateEvent(eventId, {
    title: input.title,
    description: input.description,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    isOnline: input.isOnline,
    location: input.location,
  });

  return toCommunityEventDetail(row);
}

export async function deleteEvent(
  slug: string,
  eventId: string,
  actor: Actor,
): Promise<{ id: string; deleted: true }> {
  const context = await loadVisibleCommunity(slug, actor);
  assertCan("manage_events", context, "You cannot manage this community's events");

  const existing = await repo.findEvent(context.row.id, eventId);
  if (existing === null) {
    throw AppError.notFound("Event not found");
  }

  await repo.deleteEvent(eventId);
  return { id: eventId, deleted: true };
}

/* ── Pinned posts (decision J14) ─────────────────────────────────────────── */

/**
 * Pins a post to the community.
 *
 * Three separate checks, none of which the others imply:
 *
 *   1. **`pin_posts`** — the caller runs the place (moderator and above).
 *   2. **The post belongs to *this* community.** Without this, a moderator of
 *      one community could pin a post out of another — including one out of a
 *      private community they have no standing in, which would then be listed
 *      by id on a page anyone can read.
 *   3. **The post is not deleted.** `postBelongsTo` filters `deletedAt`, so a
 *      soft-deleted post cannot be resurrected into a pinned slot.
 *
 * The composite primary key `[communityId, postId]` is the arbiter for
 * duplicates, so a second pin is a 409 rather than a second row.
 */
export async function pinPost(
  slug: string,
  actor: Actor,
  postId: string,
): Promise<{ pinnedPostIds: string[] }> {
  const context = await loadVisibleCommunity(slug, actor);
  assertCan("pin_posts", context, "You cannot pin posts in this community");

  const belongs = await repo.postBelongsTo(context.row.id, postId, actor.id);
  if (!belongs) {
    // 404, not 422: from this community's perspective the post does not exist,
    // and saying "wrong community" would confirm a post the caller may have no
    // right to know about.
    throw AppError.notFound("Post not found in this community");
  }

  try {
    await repo.pinPost(context.row.id, postId, actor.id);
  } catch (error) {
    if (isPinConflict(error)) {
      throw AppError.conflict("That post is already pinned");
    }
    throw error;
  }

  return { pinnedPostIds: await repo.pinnedPostIds(context.row.id) };
}

export async function unpinPost(
  slug: string,
  actor: Actor,
  postId: string,
): Promise<{ pinnedPostIds: string[] }> {
  const context = await loadVisibleCommunity(slug, actor);
  assertCan("pin_posts", context, "You cannot pin posts in this community");

  const removed = await repo.unpinPost(context.row.id, postId);
  if (!removed) {
    throw AppError.notFound("That post is not pinned");
  }

  return { pinnedPostIds: await repo.pinnedPostIds(context.row.id) };
}

/**
 * Pinned posts, projected through the Phase 6 post view.
 *
 * A pin is only a reference; the post itself still has to pass the ordinary
 * post rules, so this reads them back through the posts repository rather than
 * trusting the join. A post that was pinned and later deleted simply drops out.
 */
export async function listPinnedPosts(slug: string, viewer: Viewer): Promise<string[]> {
  const context = await loadVisibleCommunity(slug, viewer);
  const ids = await repo.pinnedPostIds(context.row.id);

  if (ids.length === 0) return [];

  const live = await postsRepo.findLiveIds(ids);
  return ids.filter((id) => live.has(id));
}

/** `P2002` on the composite pin key. */
function isPinConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
