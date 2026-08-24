import { AuditAction, recordAuditEvent, type AuditContext } from "../../utils/audit.js";
import { buildCursorPage, type CursorPage } from "../../utils/pagination.js";
import * as postsRepo from "../posts/posts.repository.js";
import * as postsService from "../posts/posts.service.js";
import type { CreatePostInput } from "../posts/posts.schema.js";
import type { PostView } from "../posts/posts.types.js";
import {
  assertCan,
  loadVisibleCommunity,
  type Actor,
  type Viewer,
} from "./communities.service.js";

/**
 * Posts published into a community (decisions J2, J3, J4).
 *
 * The whole point of routing creation through here rather than reopening
 * `POST /posts` is that **`communityId` is never client-supplied**. It comes
 * from the community the route resolved and the gate approved, so a client
 * cannot publish into a community it has no standing in by naming one in a
 * body field — the schema has no such field at all.
 *
 * Reads and writes both reuse the Phase 6 machinery unchanged: the same
 * `createPostSchema`, the same repository writes, the same counters, the same
 * projection. This module supplies the community context and nothing else.
 */

/**
 * Creates a post in a community.
 *
 * `create_post` is a membership grant, so a non-member is refused even in a
 * public community, and — deliberately — so is a platform admin who has not
 * joined (decision J4: posting is participation, not moderation).
 */
export async function create(
  slug: string,
  actor: Actor,
  input: CreatePostInput,
  auditContext: AuditContext,
): Promise<PostView> {
  const context = await loadVisibleCommunity(slug, actor);
  assertCan("create_post", context, "Join this community before posting in it");

  // Phase 6 owns every other rule about a post — length, media protocol, poll
  // shape, project attribution. This adds one field it cannot see.
  const post = await postsService.createInCommunity(
    actor,
    input,
    context.row.id,
    auditContext,
  );

  await recordAuditEvent({
    ...auditContext,
    actorId: actor.id,
    action: AuditAction.POST_CREATED,
    targetType: "community",
    targetId: context.row.id,
    metadata: { postId: post.id },
  });

  return post;
}

/**
 * The community's own post listing.
 *
 * Distinct from the global feed on purpose (decision J2): the feed admits only
 * public communities, so a private community's members would see an empty page
 * if this reused that filter. The community's own visibility has already been
 * settled by `loadVisibleCommunity` before a single post is read, which is what
 * makes it safe for this listing to be broader.
 */
export async function list(
  slug: string,
  viewer: Viewer,
  cursor: string | undefined,
  limit: number,
): Promise<CursorPage<PostView>> {
  const context = await loadVisibleCommunity(slug, viewer);

  const rows = await postsRepo.listCommunityPosts(
    context.row.id,
    { id: viewer.id, role: viewer.role },
    cursor,
    limit,
  );

  const page = buildCursorPage(rows, limit, (row) => row.id);
  const votes = await postsService.resolveVotes(page.items, viewer.id);

  return {
    items: postsService.projectPage(page.items, votes),
    nextCursor: page.nextCursor,
  };
}
