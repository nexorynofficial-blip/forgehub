import { Prisma } from "@prisma/client";
import type { ProjectMemberRole, UserRole } from "@prisma/client";

import { AuditAction, recordAuditEvent, type AuditContext } from "../../utils/audit.js";
import { AppError } from "../../utils/errors.js";
import { buildPagination } from "../../utils/pagination.js";
import type { Pagination } from "../../utils/response.js";
import * as follows from "../follows/follows.repository.js";
import * as usersRepo from "../users/users.repository.js";
import { can, type ProjectAccessContext } from "./project.access.js";
import { resolveProjectVisibility } from "./project.visibility.js";
import { toProjectView, toTrendingProject } from "./project.view.js";
import * as repo from "./projects.repository.js";
import type {
  CreateProjectInput,
  OwnerProjectsQuery,
  ProjectListQuery,
  TransferOwnershipInput,
  UpdateProjectInput,
} from "./projects.schema.js";
import type {
  ProjectLookupResult,
  ProjectView,
  ProjectViewerState,
  TrendingProjectView,
} from "./projects.types.js";

/**
 * Projects business logic (BACKEND_ARCHITECTURE.md §17–18).
 *
 * Owns every authorization and visibility decision; touches Prisma only
 * through the repository. Three rules recur:
 *
 *   1. **Identity comes from the caller, never the payload.** Every mutating
 *      method takes an `actor` resolved from the verified access token. No
 *      body field selects whose project is written or who owns the result.
 *   2. **Access is resolved once, by `loadVisibleProject`.** Every read and
 *      every write — including the child routes in the sibling services —
 *      enters through it, which is how decision J5's blocking rule reaches the
 *      milestone, member, update, and engagement endpoints without being
 *      re-derived four times.
 *   3. **Projection happens last, in `project.view.ts`.** Nothing here
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

/**
 * A project the viewer is permitted to see, plus everything needed to
 * authorize a write against it.
 *
 * `memberRole` is read off the already-loaded `members` array rather than
 * re-queried — the detail select carries every membership, so a second round
 * trip would buy nothing.
 */
export interface ProjectContext {
  row: repo.ProjectDetailRow;
  isOwner: boolean;
  memberRole: ProjectMemberRole | null;
  access: ProjectAccessContext;
}

/**
 * Loads a project by slug and applies the visibility gate.
 *
 * **This is the single entry point for every project-scoped operation.** A
 * child route that loaded the project itself would be one refactor away from
 * forgetting the block check, and a blocked viewer reaching a project's
 * milestone list through a side door would defeat the whole rule.
 *
 * Always throws 404, never 403, when the gate closes — a 403 would confirm the
 * project exists and, in the block case, announce the block.
 */
export async function loadVisibleProject(
  slug: string,
  viewer: Viewer,
): Promise<ProjectContext> {
  const row = await repo.findBySlug(slug);

  if (!row) {
    throw AppError.notFound("Project not found");
  }

  const isOwner = viewer.id !== null && viewer.id === row.ownerId;
  const memberRole =
    viewer.id === null
      ? null
      : (row.members.find((member) => member.userId === viewer.id)?.role ?? null);

  // Only worth a query when there is a distinct viewer who could have been
  // blocked; an owner cannot block themselves out of their own project.
  const ownerBlockedViewer =
    viewer.id !== null && !isOwner
      ? await follows.isBlocking(row.ownerId, viewer.id)
      : false;

  const decision = resolveProjectVisibility({
    viewerId: viewer.id,
    viewerRole: viewer.role,
    ownerId: row.ownerId,
    visibility: row.visibility,
    deleted: row.deletedAt !== null,
    isMember: memberRole !== null,
    ownerBlockedViewer,
  });

  if (decision === "not_found") {
    throw AppError.notFound("Project not found");
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
 * so the project's existence is not a secret from them — only the permission
 * is missing, and saying so is what lets a client show a useful message.
 */
export function assertCan(
  action: Parameters<typeof can>[0],
  context: ProjectContext,
  message = "You do not have permission to modify this project",
): void {
  if (!can(action, context.access)) {
    throw AppError.authorization(message);
  }
}

/** Viewer-relative state for the project page's action buttons. */
async function buildViewerState(
  context: ProjectContext,
  viewer: Viewer,
): Promise<ProjectViewerState | null> {
  if (viewer.id === null) return null;

  const [hasLiked, isFollowing] = await Promise.all([
    repo.hasLiked(context.row.id, viewer.id),
    repo.isFollowingProject(context.row.id, viewer.id),
  ]);

  return {
    isOwner: context.isOwner,
    isMember: context.memberRole !== null,
    role: context.memberRole,
    hasLiked,
    isFollowing,
    canEdit: can("edit_project", context.access),
    canManageMembers: can("manage_members", context.access),
  };
}

/* ── Reads ──────────────────────────────────────────────────────────────── */

export async function getBySlug(
  slug: string,
  viewer: Viewer,
): Promise<ProjectLookupResult> {
  const context = await loadVisibleProject(slug, viewer);

  return {
    project: toProjectView(context.row),
    viewer: await buildViewerState(context, viewer),
  };
}

export interface ProjectListResult {
  projects: ProjectView[];
  pagination: Pagination;
}

export async function list(
  viewer: Viewer,
  query: ProjectListQuery,
): Promise<ProjectListResult> {
  // A tag filter is normalized through the same slug rules the taxonomy was
  // built with, so `?tag=Open Source` and `?tag=open-source` are one query.
  const tagSlug =
    query.tag !== undefined ? await resolveSingleTagSlug(query.tag) : undefined;

  // An unknown tag is an empty result, not an error: filtering is a discovery
  // affordance, and 422 on a typo would be a hostile way to say "no matches".
  if (query.tag !== undefined && tagSlug === null) {
    return {
      projects: [],
      pagination: buildPagination({ page: query.page, limit: query.limit }, 0),
    };
  }

  const { rows, total } = await repo.listProjects(
    viewer,
    {
      status: query.status,
      fundingStage: query.fundingStage,
      tagSlug: tagSlug ?? undefined,
      tech: query.tech,
    },
    query.sort,
    (query.page - 1) * query.limit,
    query.limit,
  );

  return {
    projects: rows.map(toProjectView),
    pagination: buildPagination({ page: query.page, limit: query.limit }, total),
  };
}

async function resolveSingleTagSlug(ref: string): Promise<string | null> {
  const { found } = await repo.resolveTags([ref]);
  return found[0]?.slug ?? null;
}

export async function listTrending(limit: number): Promise<TrendingProjectView[]> {
  const rows = await repo.listTrending(limit);
  return rows.map(toTrendingProject);
}

/**
 * An owner's projects — also the "pinned projects" grid, which the shipped
 * frontend renders as the three most-liked (`?sort=trending&limit=3`).
 *
 * Routes through the users repository so a profile that is itself hidden
 * cannot leak its project list: a blocked viewer gets the same 404 the profile
 * would give them, rather than an empty array that confirms the account exists.
 */
export async function listByOwner(
  username: string,
  viewer: Viewer,
  query: OwnerProjectsQuery,
): Promise<ProjectListResult> {
  const owner = await usersRepo.findByUsername(username);

  if (!owner) {
    throw AppError.notFound("User not found");
  }

  if (viewer.id !== null && viewer.id !== owner.id) {
    const blocked = await follows.isBlocking(owner.id, viewer.id);
    if (blocked) {
      throw AppError.notFound("User not found");
    }
  }

  const { rows, total } = await repo.listProjects(
    viewer,
    { ownerId: owner.id },
    query.sort,
    (query.page - 1) * query.limit,
    query.limit,
  );

  return {
    projects: rows.map(toProjectView),
    pagination: buildPagination({ page: query.page, limit: query.limit }, total),
  };
}

/* ── Writes ─────────────────────────────────────────────────────────────── */

/**
 * Resolves tag references or refuses the write (decision J7).
 *
 * Unknown tags are a field-level 422 rather than a silent drop: a client that
 * submitted three tags and got two back with no explanation would have no way
 * to tell a typo from a bug.
 */
async function resolveTagIds(refs: string[] | undefined): Promise<string[] | undefined> {
  if (refs === undefined) return undefined;
  if (refs.length === 0) return [];

  const { found, missing } = await repo.resolveTags(refs);

  if (missing.length > 0) {
    throw AppError.validation("Unknown tags", [
      {
        field: "tags",
        message: `These tags do not exist: ${missing.join(", ")}. Phase 5 attaches to the existing taxonomy and cannot create new tags.`,
      },
    ]);
  }

  return found.map((tag) => tag.id);
}

export async function create(
  actor: Actor,
  input: CreateProjectInput,
  auditContext: AuditContext,
): Promise<ProjectView> {
  const tagIds = (await resolveTagIds(input.tags)) ?? [];

  const row = await repo.createProject({
    ownerId: actor.id,
    title: input.title,
    description: input.description ?? "",
    techStack: input.techStack ?? [],
    gallery: input.gallery ?? [],
    status: input.status ?? "idea",
    fundingStage: input.fundingStage ?? "not_seeking",
    visibility: input.visibility ?? "public",
    coverImageUrl: input.coverImageUrl ?? null,
    demoUrl: input.demoUrl ?? null,
    repositoryUrl: input.repositoryUrl ?? null,
    documentationUrl: input.documentationUrl ?? null,
    tagIds,
  });

  await recordAuditEvent({
    ...auditContext,
    actorId: actor.id,
    action: AuditAction.PROJECT_CREATED,
    targetType: "project",
    targetId: row.id,
    metadata: { slug: row.slug, visibility: row.visibility },
  });

  return toProjectView(row);
}

export async function update(
  slug: string,
  actor: Actor,
  input: UpdateProjectInput,
  auditContext: AuditContext,
): Promise<ProjectView> {
  const context = await loadVisibleProject(slug, actor);
  assertCan("edit_project", context);

  const tagIds = await resolveTagIds(input.tags);

  const row = await repo.updateProject(
    context.row.id,
    {
      title: input.title,
      description: input.description,
      techStack: input.techStack,
      gallery: input.gallery,
      status: input.status,
      fundingStage: input.fundingStage,
      visibility: input.visibility,
      coverImageUrl: input.coverImageUrl,
      demoUrl: input.demoUrl,
      repositoryUrl: input.repositoryUrl,
      documentationUrl: input.documentationUrl,
    },
    tagIds,
  );

  // Only visibility is audited among the ordinary fields: opening a private
  // project discloses its contents, which is a decision someone may later need
  // evidence of. Retitling is not a security event.
  if (input.visibility !== undefined && input.visibility !== context.row.visibility) {
    await recordAuditEvent({
      ...auditContext,
      actorId: actor.id,
      action: AuditAction.PROJECT_VISIBILITY_CHANGED,
      targetType: "project",
      targetId: row.id,
      metadata: { from: context.row.visibility, to: row.visibility },
    });
  }

  return toProjectView(row);
}

/**
 * Soft delete (decision J9). Owner-only, or a platform admin acting as a
 * moderator — `can("delete_project")` encodes both.
 */
export async function remove(
  slug: string,
  actor: Actor,
  auditContext: AuditContext,
): Promise<{ deleted: boolean }> {
  const context = await loadVisibleProject(slug, actor);
  assertCan("delete_project", context, "Only the project owner can delete this project");

  const deleted = await repo.softDeleteProject(context.row.id, context.row.ownerId);

  if (deleted) {
    await recordAuditEvent({
      ...auditContext,
      actorId: actor.id,
      action: AuditAction.PROJECT_DELETED,
      targetType: "project",
      targetId: context.row.id,
      metadata: { slug: context.row.slug, ownerId: context.row.ownerId },
    });
  }

  return { deleted };
}

/**
 * Ownership transfer (decision J8). Owner of record only — not a member
 * holding the `admin` role, and not a platform admin.
 */
export async function transferOwnership(
  slug: string,
  actor: Actor,
  input: TransferOwnershipInput,
  auditContext: AuditContext,
): Promise<ProjectView> {
  const context = await loadVisibleProject(slug, actor);
  assertCan(
    "transfer_ownership",
    context,
    "Only the project owner can transfer ownership",
  );

  const recipient = await usersRepo.findByUsername(input.username);

  if (!recipient) {
    throw AppError.notFound("User not found");
  }

  if (recipient.id === context.row.ownerId) {
    throw AppError.conflict("That user already owns this project");
  }

  const row = await repo.transferOwnership(
    context.row.id,
    context.row.ownerId,
    recipient.id,
  );

  await recordAuditEvent({
    ...auditContext,
    actorId: actor.id,
    action: AuditAction.PROJECT_OWNERSHIP_TRANSFERRED,
    targetType: "project",
    targetId: row.id,
    metadata: { from: context.row.ownerId, to: recipient.id, slug: row.slug },
  });

  return toProjectView(row);
}

/** Shared `P2002` guard for the sibling services. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
