import { Prisma } from "@prisma/client";
import type { CommunityRole, UserRole } from "@prisma/client";

import { AppError } from "../../utils/errors.js";
import { buildCursorPage, type CursorPage } from "../../utils/pagination.js";
import { AuditAction, recordAuditEvent, type AuditContext } from "../../utils/audit.js";
import * as follows from "../follows/follows.repository.js";
import * as usersRepo from "../users/users.repository.js";
import { can, type CommunityAccessContext } from "./community.access.js";
import {
  isCommunityListable,
  resolveCommunityVisibility,
  resolveJoin,
} from "./community.visibility.js";
import {
  toCommunityMemberWithUser,
  toCommunitySummary,
  toCommunityView,
} from "./community.view.js";
import * as repo from "./communities.repository.js";
import type {
  CommunityListQuery,
  CreateCommunityInput,
  UpdateCommunityInput,
} from "./communities.schema.js";
import type {
  CommunityLookupResult,
  CommunityMemberWithUserView,
  CommunitySummaryView,
  CommunityView,
  CommunityViewerState,
} from "./communities.types.js";

/**
 * Communities business logic (BACKEND_ARCHITECTURE.md §12, §17–18).
 *
 * Owns every authorization and visibility decision; touches Prisma only
 * through the repository. Three rules recur, carried forward from Phases 4–6:
 *
 *   1. **Identity comes from the caller, never the payload.** Every mutating
 *      method takes an `actor` resolved from the verified access token. No body
 *      field selects which community is written or who owns the result.
 *   2. **Access is resolved once, by `loadVisibleCommunity`.** Every read and
 *      every write — including the rule, event, pin, member, and post routes
 *      that follow — enters through it, which is how the blocking rule reaches
 *      every child endpoint without being re-derived once per surface.
 *   3. **Projection happens last, in `community.view.ts`.** Nothing here
 *      hand-assembles a response, and no raw Prisma row leaves this module.
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

/**
 * A community the viewer is permitted to see, plus everything needed to
 * authorize a write against it.
 */
export interface CommunityContext {
  row: repo.CommunityDetailRow;
  isOwner: boolean;
  memberRole: CommunityRole | null;
  access: CommunityAccessContext;
}

/**
 * Loads a community by slug and applies the visibility gate.
 *
 * **This is the single entry point for every community-scoped operation.** A
 * child route that loaded the community itself would be one refactor away from
 * forgetting the block check, and a blocked viewer reaching a community's rule
 * list or member roster through a side door would defeat the whole rule.
 *
 * Always throws 404, never 403, when the gate closes — a 403 would confirm the
 * community exists and, in the block case, announce the block.
 *
 * The viewer's own membership is queried separately rather than read off
 * `row.members`, because the detail select carries only the moderating roles
 * (see `communityDetailSelect`). A plain member must still be recognised as a
 * member, and inferring that from a filtered array would quietly deny every
 * ordinary member access to their own private community.
 */
export async function loadVisibleCommunity(
  slug: string,
  viewer: Viewer,
): Promise<CommunityContext> {
  const row = await repo.findBySlug(slug);

  if (!row) {
    throw AppError.notFound("Community not found");
  }

  const isOwner = viewer.id !== null && viewer.id === row.ownerId;

  const memberRole =
    viewer.id === null
      ? null
      : ((await repo.findMembership(row.id, viewer.id))?.role ?? null);

  // Only worth a query when there is a distinct viewer who could have been
  // blocked; an owner cannot block themselves out of their own community.
  const ownerBlockedViewer =
    viewer.id !== null && !isOwner
      ? await follows.isBlocking(row.ownerId, viewer.id)
      : false;

  const decision = resolveCommunityVisibility({
    viewerId: viewer.id,
    viewerRole: viewer.role,
    ownerId: row.ownerId,
    visibility: row.visibility,
    deleted: row.deletedAt !== null,
    isMember: memberRole !== null,
    ownerBlockedViewer,
  });

  if (decision === "not_found") {
    throw AppError.notFound("Community not found");
  }

  return {
    row,
    isOwner,
    memberRole,
    access: { isOwner, memberRole, viewerRole: viewer.role },
  };
}

/**
 * Authorizes a write, or throws.
 *
 * 403 rather than 404 here: the caller has already passed the visibility gate,
 * so the community's existence is not a secret from them — only the permission
 * is missing, and saying so is what lets a client show a useful message.
 */
export function assertCan(
  action: Parameters<typeof can>[0],
  context: CommunityContext,
  message = "You do not have permission to modify this community",
): void {
  if (!can(action, context.access)) {
    throw AppError.authorization(message);
  }
}

/** Viewer-relative state for the community page's affordances. */
function viewerStateFor(context: CommunityContext, viewer: Viewer): CommunityViewerState {
  const join = resolveJoin({
    visibility: context.row.visibility,
    isMember: context.memberRole !== null,
  });

  return {
    isOwner: context.isOwner,
    isMember: context.memberRole !== null,
    role: context.memberRole,
    canJoin: viewer.id !== null && join.allowed,
    canPost: can("create_post", context.access),
    canEdit: can("edit_community", context.access),
    canManageMembers: can("manage_members", context.access),
    canModerate: can("remove_posts", context.access),
  };
}

/* ── Reads ──────────────────────────────────────────────────────────────── */

export async function getBySlug(
  slug: string,
  viewer: Viewer,
): Promise<CommunityLookupResult> {
  const context = await loadVisibleCommunity(slug, viewer);

  return {
    community: toCommunityView(context.row),
    viewer: viewer.id === null ? null : viewerStateFor(context, viewer),
  };
}

/**
 * Cursor-paginated discovery (decision J12).
 *
 * The listing filter is applied in SQL by `listVisibilityWhere`, which must
 * agree with `isCommunityListable` branch for branch. The pure function is
 * asserted over the returned rows in the integration tests, so a divergence
 * fails loudly rather than producing quietly short pages.
 */
export async function list(
  viewer: Viewer,
  query: CommunityListQuery,
): Promise<CursorPage<CommunitySummaryView> & { total: null }> {
  const rows = await repo.listCommunities(
    viewer,
    { category: query.category, q: query.q },
    query.sort,
    query.cursor,
    query.limit,
  );

  const page = buildCursorPage(rows, query.limit, (row) => row.id);

  return {
    items: page.items.map(toCommunitySummary),
    nextCursor: page.nextCursor,
    // Deliberately null: a COUNT over a visibility-filtered set costs a second
    // full scan, and no shipped surface renders a community total.
    total: null,
  };
}

/** Communities a given user belongs to, scoped to what the viewer may see. */
export async function listByMember(
  username: string,
  viewer: Viewer,
  cursor: string | undefined,
  limit: number,
): Promise<CursorPage<CommunitySummaryView>> {
  const user = await usersRepo.findByUsername(username);
  if (!user) {
    throw AppError.notFound("User not found");
  }

  // A blocked viewer gets the same 404 the profile itself would give them.
  if (viewer.id !== null && viewer.id !== user.id) {
    if (await follows.isBlocking(user.id, viewer.id)) {
      throw AppError.notFound("User not found");
    }
  }

  const rows = await repo.listByMember(user.id, viewer, cursor, limit);
  const page = buildCursorPage(rows, limit, (row) => row.id);

  return { items: page.items.map(toCommunitySummary), nextCursor: page.nextCursor };
}

export async function listMembers(
  slug: string,
  viewer: Viewer,
  cursor: string | undefined,
  limit: number,
): Promise<CursorPage<CommunityMemberWithUserView>> {
  const context = await loadVisibleCommunity(slug, viewer);
  const rows = await repo.listMembers(context.row.id, cursor, limit);
  const page = buildCursorPage(rows, limit, (row) => row.userId);

  return {
    items: page.items.map(toCommunityMemberWithUser),
    nextCursor: page.nextCursor,
  };
}

/* ── Writes ─────────────────────────────────────────────────────────────── */

/**
 * Resolves tag references or refuses the write (decision J8).
 *
 * Unknown tags are a 422 rather than a silent drop: a client that asked for
 * three tags and got two back has been lied to, and silently creating them
 * would let any authenticated user extend the shared taxonomy.
 */
async function resolveTagIds(refs: string[] | undefined): Promise<string[] | undefined> {
  if (refs === undefined) return undefined;
  if (refs.length === 0) return [];

  const { found, missing } = await repo.resolveTags(refs);

  if (missing.length > 0) {
    throw AppError.validation("Unknown tags", [
      { field: "tags", message: `Unknown tags: ${missing.join(", ")}` },
    ]);
  }

  return found.map((tag) => tag.id);
}

export async function create(
  actor: Actor,
  input: CreateCommunityInput,
  audit: AuditContext,
): Promise<CommunityView> {
  const tagIds = (await resolveTagIds(input.tags)) ?? [];

  const row = await repo.createCommunity({
    ownerId: actor.id,
    name: input.name,
    description: input.description ?? "",
    category: input.category,
    visibility: input.visibility ?? "public",
    avatarUrl: input.avatarUrl ?? null,
    bannerUrl: input.bannerUrl ?? null,
    tagIds,
  });

  await recordAuditEvent({
    ...audit,
    action: AuditAction.COMMUNITY_CREATED,
    actorId: actor.id,
    targetType: "community",
    targetId: row.id,
  });

  return toCommunityView(row);
}

export async function update(
  slug: string,
  actor: Actor,
  input: UpdateCommunityInput,
): Promise<CommunityView> {
  const context = await loadVisibleCommunity(slug, actor);
  assertCan("edit_community", context);

  const tagIds = await resolveTagIds(input.tags);

  const row = await repo.updateCommunity(
    context.row.id,
    {
      name: input.name,
      description: input.description,
      category: input.category,
      visibility: input.visibility,
      avatarUrl: input.avatarUrl,
      bannerUrl: input.bannerUrl,
    },
    tagIds,
  );

  return toCommunityView(row);
}

export async function remove(
  slug: string,
  actor: Actor,
  audit: AuditContext,
): Promise<{ id: string; deleted: true }> {
  const context = await loadVisibleCommunity(slug, actor);
  assertCan("delete_community", context, "Only the owner may delete this community");

  await repo.softDeleteCommunity(context.row.id);

  await recordAuditEvent({
    ...audit,
    action: AuditAction.COMMUNITY_DELETED,
    actorId: actor.id,
    targetType: "community",
    targetId: context.row.id,
  });

  return { id: context.row.id, deleted: true };
}

/* ── Shared helpers for the sibling services ─────────────────────────────── */

/** Shared `P2002` guard, matching the Phase 6 helper of the same name. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export { isCommunityListable, viewerStateFor };
