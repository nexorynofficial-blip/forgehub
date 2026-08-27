import { Prisma } from "@prisma/client";
import type { UserRole } from "@prisma/client";

import { notificationPort } from "../../ports/notification.port.js";
import { AuditAction, recordAuditEvent, type AuditContext } from "../../utils/audit.js";
import { AppError } from "../../utils/errors.js";
import * as follows from "../follows/follows.repository.js";
import { parseMentions } from "./mentions.js";
import { resolvePostVisibility, type CommunityStanding } from "./post.visibility.js";
import { toPostView } from "./post.view.js";
import * as repo from "./posts.repository.js";
import type { CreatePostInput, UpdatePostInput } from "./posts.schema.js";
import type { PostLookupResult, PostView, PostViewerState } from "./posts.types.js";

/**
 * Posts business logic (BACKEND_ARCHITECTURE.md §17–18).
 *
 * Owns every authorization and visibility decision; touches Prisma only
 * through the repository. Three rules recur:
 *
 *   1. **Identity comes from the caller, never the payload.** Every mutating
 *      method takes an `actor` resolved from the verified access token.
 *   2. **Access is resolved once, by `loadVisiblePost`.** Comments, likes,
 *      bookmarks, and votes all enter through it, which is how the blocking
 *      and community rules reach every child route without being re-derived.
 *   3. **Projection happens last, in `post.view.ts`.** Nothing here
 *      hand-assembles a response.
 */

export interface Viewer {
  id: string | null;
  role: UserRole | null;
}

export const ANONYMOUS: Viewer = { id: null, role: null };

/** An authenticated actor. Distinct from `Viewer`: `id` is never null. */
export interface Actor {
  id: string;
  role: UserRole;
}

export interface PostContext {
  row: repo.PostDetailRow;
  isAuthor: boolean;
}

/**
 * Loads a post by id and applies the visibility gate.
 *
 * **This is the single entry point for every post-scoped operation.** A child
 * route that loaded the post itself would be one refactor away from forgetting
 * the block check, and a blocked viewer reaching a post's comments through a
 * side door would defeat the rule entirely.
 *
 * Always throws 404, never 403, when the gate closes.
 */
export async function loadVisiblePost(
  postId: string,
  viewer: Viewer,
): Promise<PostContext> {
  const row = await repo.findById(postId);

  if (!row) {
    throw AppError.notFound("Post not found");
  }

  const isAuthor = viewer.id !== null && viewer.id === row.authorId;

  // Only worth a query when there is a distinct viewer who could have been
  // blocked; an author cannot block themselves out of their own post.
  const authorBlockedViewer =
    viewer.id !== null && !isAuthor
      ? await follows.isBlocking(row.authorId, viewer.id)
      : false;

  // Phase 7 seam: resolves the community's standing for this viewer, or null
  // for an ordinary post. Phase 6 passed `inCommunity: row.communityId !== null`
  // here, which made every community post author-only.
  const community = await resolveCommunityStanding(row.communityId, viewer);

  const decision = resolvePostVisibility({
    viewerId: viewer.id,
    viewerRole: viewer.role,
    authorId: row.authorId,
    visibility: row.visibility,
    deleted: row.deletedAt !== null,
    authorBlockedViewer,
    community,
  });

  if (decision === "not_found") {
    throw AppError.notFound("Post not found");
  }

  return { row, isAuthor };
}

/** Author, or an admin acting as a moderator. */
function canModify(context: PostContext, actor: Actor): boolean {
  if (context.isAuthor) return true;
  return actor.role !== "guest" && isAdmin(actor.role);
}

function isAdmin(role: UserRole): boolean {
  return role === "moderator" || role === "community_admin" || role === "platform_admin";
}

/* ── Viewer state ───────────────────────────────────────────────────────── */

/**
 * Resolves which poll option the viewer chose, for a whole page of posts, in
 * one query rather than one per post — the N+1 TRD §38 forbids.
 */
export async function resolveVotes(
  rows: repo.PostDetailRow[],
  viewerId: string | null,
): Promise<Map<string, string>> {
  const pollIds = rows
    .map((row) => row.poll?.id)
    .filter((id): id is string => id !== undefined);

  if (viewerId === null || pollIds.length === 0) return new Map();
  return repo.findVotesForPolls(pollIds, viewerId);
}

/** Projects a page of rows, attaching each viewer's vote. */
export function projectPage(
  rows: repo.PostDetailRow[],
  votes: Map<string, string>,
): PostView[] {
  return rows.map((row) =>
    toPostView(row, row.poll ? (votes.get(row.poll.id) ?? null) : null),
  );
}

async function buildViewerState(
  context: PostContext,
  viewer: Viewer,
): Promise<{ state: PostViewerState | null; votedOptionId: string | null }> {
  if (viewer.id === null) return { state: null, votedOptionId: null };

  const pollId = context.row.poll?.id ?? null;
  const [hasLiked, isBookmarked, votedOptionId] = await Promise.all([
    repo.hasLikedPost(context.row.id, viewer.id),
    repo.isBookmarked(context.row.id, viewer.id),
    pollId !== null ? repo.findVotedOptionId(pollId, viewer.id) : Promise.resolve(null),
  ]);

  const modifiable = context.isAuthor || isAdmin(viewer.role ?? "guest");

  return {
    state: {
      hasLiked,
      isBookmarked,
      votedOptionId,
      isAuthor: context.isAuthor,
      canEdit: context.isAuthor,
      canDelete: modifiable,
    },
    votedOptionId,
  };
}

/* ── Reads ──────────────────────────────────────────────────────────────── */

export async function getById(postId: string, viewer: Viewer): Promise<PostLookupResult> {
  const context = await loadVisiblePost(postId, viewer);
  const { state, votedOptionId } = await buildViewerState(context, viewer);

  return { post: toPostView(context.row, votedOptionId), viewer: state };
}

/* ── Mentions (decision J6) ─────────────────────────────────────────────── */

/**
 * Parses `@handles`, resolves them to real accounts, and announces each
 * through the notification port. No `Mention` row is written — the schema is
 * frozen and has none; Phase 9 owns delivery and persistence.
 *
 * Never throws: a mention that cannot be resolved, or a port that fails, must
 * not fail the write that produced it.
 *
 * **`entityType` is a parameter, corrected in Phase 9.** It was hardcoded to
 * `"post"`, while `comments.service.ts` passes a *comment* id — so a mention
 * inside a comment was recorded as pointing at a post that does not exist. The
 * defect was invisible while the notification port was a no-op, because
 * nothing persisted the mismatch; activating delivery turns it into a
 * notification that deep-links nowhere. It defaults to `"post"` so the two
 * post call sites read unchanged.
 */
export async function announceMentions(
  content: string,
  actorId: string,
  entityId: string,
  entityType: "post" | "comment" = "post",
): Promise<void> {
  const handles = parseMentions(content);
  if (handles.length === 0) return;

  const users = await repo.findUserIdsByUsernames(handles);

  for (const user of users) {
    // Mentioning yourself is not an event.
    if (user.id === actorId) continue;

    await notificationPort.emit({
      recipientId: user.id,
      actorId,
      type: "mention",
      entityType,
      entityId,
    });
  }
}

/* ── Writes ─────────────────────────────────────────────────────────────── */

/**
 * Validates optional project attribution (decision J8).
 *
 * A post may name a project, but naming it never writes to the project — that
 * separation is what keeps Phase 5's changelog independent of the feed. The
 * project must exist, be undeleted, and not be private to someone else.
 */
async function assertProjectAttribution(
  projectId: string,
  actorId: string,
): Promise<void> {
  const project = await repo.findProjectOwner(projectId);

  if (!project || project.deletedAt !== null) {
    throw AppError.validation("Unknown project", [
      { field: "projectId", message: "That project does not exist." },
    ]);
  }

  if (project.visibility === "private" && project.ownerId !== actorId) {
    // Attributing a post to someone's private project would disclose that it
    // exists, so this is refused rather than silently dropped.
    throw AppError.validation("Unknown project", [
      { field: "projectId", message: "That project does not exist." },
    ]);
  }
}

function mediaFrom(input: CreatePostInput | UpdatePostInput) {
  if (input.media !== undefined) {
    return input.media.map((item) => ({
      url: item.url,
      type: item.type,
      ...(item.width !== undefined ? { width: item.width } : {}),
      ...(item.height !== undefined ? { height: item.height } : {}),
    }));
  }

  if (input.mediaUrls !== undefined) {
    return input.mediaUrls.map((url) => ({ url, type: "image" as const }));
  }

  return undefined;
}

export async function create(
  actor: Actor,
  input: CreatePostInput,
  auditContext: AuditContext,
): Promise<PostView> {
  return createInternal(actor, input, null, auditContext);
}

/**
 * Creates a post inside a community (Phase 7, decision J3).
 *
 * `communityId` is a parameter, never a field of `input` — `createPostSchema`
 * has no such key, so a client cannot select the community by sending one. The
 * caller has already resolved it from the route and checked `create_post`
 * membership.
 *
 * Every other rule is Phase 6's, untouched: the same validation, the same
 * counters, the same mention announcement, the same projection.
 */
export async function createInCommunity(
  actor: Actor,
  input: CreatePostInput,
  communityId: string,
  auditContext: AuditContext,
): Promise<PostView> {
  return createInternal(actor, input, communityId, auditContext);
}

async function createInternal(
  actor: Actor,
  input: CreatePostInput,
  communityId: string | null,
  auditContext: AuditContext,
): Promise<PostView> {
  if (input.projectId !== undefined && input.projectId !== null) {
    await assertProjectAttribution(input.projectId, actor.id);
  }

  const row = await repo.createPost({
    authorId: actor.id,
    type: input.type,
    content: input.content,
    visibility: input.visibility ?? "public",
    projectId: input.projectId ?? null,
    communityId,
    codeLanguage: input.codeSnippet?.language ?? null,
    codeContent: input.codeSnippet?.code ?? null,
    media: mediaFrom(input) ?? [],
    poll: input.poll
      ? {
          question: input.poll.question,
          closesAt: input.poll.closesAt ?? null,
          options: input.poll.options,
        }
      : null,
  });

  await recordAuditEvent({
    ...auditContext,
    actorId: actor.id,
    action: AuditAction.POST_CREATED,
    targetType: "post",
    targetId: row.id,
    metadata: { type: row.type, visibility: row.visibility },
  });

  await announceMentions(row.content, actor.id, row.id);

  return toPostView(row, null);
}

export async function update(
  postId: string,
  actor: Actor,
  input: UpdatePostInput,
): Promise<PostView> {
  const context = await loadVisiblePost(postId, actor);

  // Editing is author-only. An admin may remove content but not rewrite it in
  // someone else's voice — that would be putting words in their mouth.
  if (!context.isAuthor) {
    throw AppError.authorization("You can only edit your own posts");
  }

  const row = await repo.updatePost(postId, {
    content: input.content,
    visibility: input.visibility,
    ...(input.codeSnippet !== undefined
      ? {
          codeLanguage: input.codeSnippet === null ? null : input.codeSnippet.language,
          codeContent: input.codeSnippet === null ? null : input.codeSnippet.code,
        }
      : {}),
    media: mediaFrom(input),
  });

  if (input.content !== undefined) {
    await announceMentions(row.content, actor.id, row.id);
  }

  return toPostView(row, null);
}

export async function remove(
  postId: string,
  actor: Actor,
  auditContext: AuditContext,
): Promise<{ deleted: boolean }> {
  const context = await loadVisiblePost(postId, actor);

  if (!canModify(context, actor)) {
    throw AppError.authorization("You can only delete your own posts");
  }

  const deleted = await repo.softDeletePost(postId);

  if (deleted) {
    await recordAuditEvent({
      ...auditContext,
      actorId: actor.id,
      action: AuditAction.POST_DELETED,
      targetType: "post",
      targetId: postId,
      metadata: { authorId: context.row.authorId, byAuthor: context.isAuthor },
    });
  }

  return { deleted };
}

/** Shared `P2002` guard for the sibling services. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export { isAdmin };

/* ── Phase 7 seam (decision J2) ──────────────────────────────────────────── */

/**
 * Resolves how a post's community bears on this viewer's access.
 *
 * Added in Phase 7 to replace decision J9's placeholder, which made every post
 * carrying a `communityId` author-only because no `Community` existed to
 * evaluate. Returns `null` for an ordinary post, so a non-community post takes
 * exactly the path it took in Phase 6.
 *
 * Lives here rather than in `communities/` to keep the dependency pointing one
 * way — the posts module is the older, closed one, and having it import a
 * *repository* rather than a sibling service avoids a cycle through
 * `communities.service`, which itself reads posts for pinning.
 */
async function resolveCommunityStanding(
  communityId: string | null,
  viewer: Viewer,
): Promise<CommunityStanding | null> {
  if (communityId === null) return null;

  const community = await repo.findCommunityStanding(communityId);

  // A community row that has vanished leaves its posts unreachable rather than
  // promoting them to ordinary posts (decision J13).
  if (community === null) return "hidden";
  if (community.deletedAt !== null) return "hidden";

  if (community.visibility === "public") return "listable";

  // Unlisted: readable by anyone holding the id, never enumerable.
  if (community.visibility === "unlisted") return "readable";

  // Private from here down — members and platform admins only.
  if (viewer.id !== null) {
    const membership = await repo.findCommunityMembership(communityId, viewer.id);
    if (membership) return "readable";
  }

  if (viewer.role !== null && isAdmin(viewer.role)) return "readable";

  return "hidden";
}
