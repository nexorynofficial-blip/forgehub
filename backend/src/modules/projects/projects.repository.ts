import { Prisma } from "@prisma/client";
import type {
  FundingStage,
  ProjectMemberRole,
  ProjectStatus,
  Visibility,
} from "@prisma/client";

import { prisma } from "../../database/prisma.js";
import { isAdminRole } from "../../middleware/role.middleware.js";
import { initialSlugFor, slugCandidate, slugify } from "../../utils/slug.js";
import { summarySelect } from "../users/users.repository.js";
import type { ProjectSort } from "./projects.schema.js";

/**
 * The only layer that touches Prisma for projects and their children
 * (BACKEND_ARCHITECTURE.md §4).
 *
 * Two invariants live here rather than in the service, because they are only
 * safe at the database level:
 *
 *   - **Counters move with the row.** `likesCount`, `followersCount`,
 *     `viewsCount`, `User.projectsCount`, and `Tag.usageCount` are all
 *     denormalized (Phase 2), so every write pairs the row change with the
 *     counter change inside one transaction (decisions J7, J9).
 *   - **`progressPercent` is derived** (decision J3). It is recomputed from the
 *     milestone rows inside the same transaction that changed them, so it can
 *     never disagree with the roadmap the client is looking at.
 *
 * `deletedAt` is *selected* by the detail query because the visibility gate
 * needs it, and deliberately never projected — see `project.view.ts`.
 */

/* ── Selects and row types ───────────────────────────────────────────────── */

/**
 * The full project payload.
 *
 * `members` selects `userId`/`role`/`joinedAt` only: the frontend's embedded
 * `Project.members` is userId-only and is joined against a people directory
 * client-side. The richer joined shape is served by the members endpoint.
 */
const projectDetailSelect = {
  id: true,
  slug: true,
  ownerId: true,
  title: true,
  description: true,
  coverImageUrl: true,
  gallery: true,
  techStack: true,
  status: true,
  fundingStage: true,
  progressPercent: true,
  visibility: true,
  demoUrl: true,
  repositoryUrl: true,
  documentationUrl: true,
  viewsCount: true,
  likesCount: true,
  followersCount: true,
  createdAt: true,
  updatedAt: true,
  /** Read for the visibility gate. Never projected into a response. */
  deletedAt: true,
  owner: { select: summarySelect },
  members: {
    select: { userId: true, role: true, joinedAt: true },
    orderBy: { joinedAt: "asc" },
  },
  milestones: {
    select: {
      id: true,
      title: true,
      description: true,
      isComplete: true,
      targetDate: true,
      completedAt: true,
      position: true,
    },
    // The frontend renders milestones in array order with no sort of its own,
    // so the ordering contract lives in the response sequence.
    orderBy: { position: "asc" },
  },
  tags: { select: { tag: { select: { name: true, slug: true } } } },
} satisfies Prisma.ProjectSelect;

export type ProjectDetailRow = Prisma.ProjectGetPayload<{
  select: typeof projectDetailSelect;
}>;

/**
 * Backs the dashboard's trending widget, whose type is deliberately *not* the
 * full project — flat `likesCount`, denormalized owner name and avatar.
 */
const trendingSelect = {
  id: true,
  slug: true,
  title: true,
  description: true,
  coverImageUrl: true,
  techStack: true,
  likesCount: true,
  progressPercent: true,
  owner: { select: { displayName: true, profile: { select: { avatarUrl: true } } } },
} satisfies Prisma.ProjectSelect;

export type TrendingProjectRow = Prisma.ProjectGetPayload<{
  select: typeof trendingSelect;
}>;

/** The joined member shape, for the members endpoint. */
const memberSelect = {
  userId: true,
  role: true,
  joinedAt: true,
  user: { select: summarySelect },
} satisfies Prisma.ProjectMemberSelect;

export type ProjectMemberRow = Prisma.ProjectMemberGetPayload<{
  select: typeof memberSelect;
}>;

const milestoneSelect = {
  id: true,
  title: true,
  description: true,
  isComplete: true,
  targetDate: true,
  completedAt: true,
  position: true,
} satisfies Prisma.ProjectMilestoneSelect;

export type MilestoneRow = Prisma.ProjectMilestoneGetPayload<{
  select: typeof milestoneSelect;
}>;

const updateSelect = {
  id: true,
  projectId: true,
  authorId: true,
  content: true,
  createdAt: true,
  updatedAt: true,
  author: { select: summarySelect },
} satisfies Prisma.ProjectUpdateSelect;

export type ProjectUpdateRow = Prisma.ProjectUpdateGetPayload<{
  select: typeof updateSelect;
}>;

/* ── Viewer-scoped filtering ─────────────────────────────────────────────── */

export interface RepoViewer {
  id: string | null;
  role: import("@prisma/client").UserRole | null;
}

/**
 * The listing filter, expressed in SQL rather than applied after the fact.
 *
 * This must agree with `isProjectListable` in `project.visibility.ts` branch
 * for branch. Filtering in the database and *also* in a pure function is not
 * duplication for its own sake: the pure function is what the unit tests pin
 * the rules to, and this is what keeps a hidden project from ever being
 * counted in `total` or consuming a page slot. If the two disagreed, paging
 * would silently return short pages.
 *
 * The block clause uses `owner.blocksMade` — a project is invisible to a
 * viewer its owner has blocked, which is decision J5 expressed as a join.
 */
function listVisibilityWhere(viewer: RepoViewer): Prisma.ProjectWhereInput {
  if (viewer.id === null) {
    return { deletedAt: null, visibility: "public" };
  }

  const notBlocked: Prisma.ProjectWhereInput = {
    owner: { blocksMade: { none: { blockedId: viewer.id } } },
  };

  if (viewer.role !== null && isAdminRole(viewer.role)) {
    return { deletedAt: null, ...notBlocked };
  }

  return {
    deletedAt: null,
    ...notBlocked,
    OR: [
      { visibility: "public" },
      { ownerId: viewer.id },
      { members: { some: { userId: viewer.id } } },
    ],
  };
}

/**
 * Sort keys map to indexed columns only (see `projects.schema.ts`).
 * `trending` is served by `projects(visibility, deletedAt, likesCount DESC)`.
 */
function orderFor(sort: ProjectSort): Prisma.ProjectOrderByWithRelationInput[] {
  switch (sort) {
    case "trending":
      return [{ likesCount: "desc" }, { createdAt: "desc" }];
    case "progress":
      return [{ progressPercent: "desc" }, { createdAt: "desc" }];
    case "updated":
      return [{ updatedAt: "desc" }];
    case "recent":
    default:
      return [{ createdAt: "desc" }];
  }
}

/* ── Reads ──────────────────────────────────────────────────────────────── */

/**
 * Slug lookup. Deliberately does **not** filter `deletedAt` — the visibility
 * gate needs to distinguish "soft-deleted" from "never existed" internally,
 * even though both resolve to the same 404 for the caller.
 */
export async function findBySlug(slug: string): Promise<ProjectDetailRow | null> {
  return prisma.project.findUnique({ where: { slug }, select: projectDetailSelect });
}

export async function findById(id: string): Promise<ProjectDetailRow | null> {
  return prisma.project.findUnique({ where: { id }, select: projectDetailSelect });
}

export interface ProjectListFilter {
  status?: ProjectStatus | undefined;
  fundingStage?: FundingStage | undefined;
  /** Tag slug, already normalized. */
  tagSlug?: string | undefined;
  tech?: string | undefined;
  ownerId?: string | undefined;
}

export async function listProjects(
  viewer: RepoViewer,
  filter: ProjectListFilter,
  sort: ProjectSort,
  skip: number,
  take: number,
): Promise<{ rows: ProjectDetailRow[]; total: number }> {
  const where: Prisma.ProjectWhereInput = {
    ...listVisibilityWhere(viewer),
    ...(filter.status !== undefined ? { status: filter.status } : {}),
    ...(filter.fundingStage !== undefined ? { fundingStage: filter.fundingStage } : {}),
    ...(filter.ownerId !== undefined ? { ownerId: filter.ownerId } : {}),
    ...(filter.tech !== undefined ? { techStack: { has: filter.tech } } : {}),
    ...(filter.tagSlug !== undefined
      ? { tags: { some: { tag: { slug: filter.tagSlug } } } }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.project.findMany({
      where,
      select: projectDetailSelect,
      orderBy: orderFor(sort),
      skip,
      take,
    }),
    prisma.project.count({ where }),
  ]);

  return { rows, total };
}

/**
 * Trending. Public-only by construction rather than viewer-scoped: this backs
 * a discovery widget, and surfacing a viewer's own private project inside
 * "Trending projects" would be a confusing category error.
 */
export async function listTrending(limit: number): Promise<TrendingProjectRow[]> {
  return prisma.project.findMany({
    where: { deletedAt: null, visibility: "public" },
    select: trendingSelect,
    orderBy: [{ likesCount: "desc" }, { createdAt: "desc" }],
    take: limit,
  });
}

export async function findMembers(
  projectId: string,
  skip: number,
  take: number,
): Promise<{ rows: ProjectMemberRow[]; total: number }> {
  const where: Prisma.ProjectMemberWhereInput = {
    projectId,
    user: { deletedAt: null },
  };

  const [rows, total] = await Promise.all([
    prisma.projectMember.findMany({
      where,
      select: memberSelect,
      orderBy: { joinedAt: "asc" },
      skip,
      take,
    }),
    prisma.projectMember.count({ where }),
  ]);

  return { rows, total };
}

export async function findMemberRole(
  projectId: string,
  userId: string,
): Promise<ProjectMemberRole | null> {
  const row = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { role: true },
  });
  return row?.role ?? null;
}

export async function listMilestones(projectId: string): Promise<MilestoneRow[]> {
  return prisma.projectMilestone.findMany({
    where: { projectId },
    select: milestoneSelect,
    orderBy: { position: "asc" },
  });
}

export async function findMilestone(
  id: string,
  projectId: string,
): Promise<MilestoneRow | null> {
  return prisma.projectMilestone.findFirst({
    where: { id, projectId },
    select: milestoneSelect,
  });
}

/** Cursor page over the changelog, newest first. */
export async function listUpdates(
  projectId: string,
  cursor: string | undefined,
  limit: number,
): Promise<ProjectUpdateRow[]> {
  return prisma.projectUpdate.findMany({
    where: { projectId, deletedAt: null },
    select: updateSelect,
    // Over-fetch by one: the extra row proves more data exists without a
    // second COUNT (see `utils/pagination.buildCursorPage`).
    take: limit + 1,
    ...(cursor !== undefined ? { cursor: { id: cursor }, skip: 1 } : {}),
    orderBy: { createdAt: "desc" },
  });
}

export async function findUpdate(
  id: string,
  projectId: string,
): Promise<ProjectUpdateRow | null> {
  return prisma.projectUpdate.findFirst({
    where: { id, projectId, deletedAt: null },
    select: updateSelect,
  });
}

export async function hasLiked(projectId: string, userId: string): Promise<boolean> {
  const row = await prisma.projectLike.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { projectId: true },
  });
  return row !== null;
}

export async function isFollowingProject(
  projectId: string,
  userId: string,
): Promise<boolean> {
  const row = await prisma.projectFollower.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { projectId: true },
  });
  return row !== null;
}

/* ── Tags (decision J7) ─────────────────────────────────────────────────── */

export interface ResolvedTag {
  id: string;
  name: string;
  slug: string;
}

/**
 * Resolves tag references against the **existing** taxonomy.
 *
 * Accepts either a display name ("Open Source") or a slug ("open-source"),
 * because the frontend's `Project.tags` holds names — both normalize through
 * `slugify`, and the seed derives its slugs the same way.
 *
 * Unknown references are returned rather than created (decision J7): Phase 5
 * attaches to the taxonomy, it does not extend it. Free-text tag creation is
 * an unbounded-taxonomy decision that belongs with Phase 10 search.
 */
export async function resolveTags(
  refs: string[],
): Promise<{ found: ResolvedTag[]; missing: string[] }> {
  if (refs.length === 0) return { found: [], missing: [] };

  const bySlug = new Map<string, string>();
  for (const ref of refs) bySlug.set(slugify(ref), ref);

  const rows = await prisma.tag.findMany({
    where: { slug: { in: [...bySlug.keys()] } },
    select: { id: true, name: true, slug: true },
  });

  const foundSlugs = new Set(rows.map((row) => row.slug));
  const missing = [...bySlug.entries()]
    .filter(([slug]) => !foundSlugs.has(slug))
    .map(([, original]) => original);

  return { found: rows, missing };
}

/**
 * Applies a replace-set of tags and moves `Tag.usageCount` for the delta.
 *
 * The decrement is guarded by `usageCount: { gt: 0 }` in the same statement.
 * That is not defensive noise: the seed creates `ProjectTag` rows without ever
 * touching `usageCount`, so seeded tags sit at 0 while genuinely being in use.
 * An unguarded decrement would drive them negative the first time a seeded
 * project's tags were edited.
 */
async function applyTagSet(
  tx: Prisma.TransactionClient,
  projectId: string,
  tagIds: string[],
): Promise<void> {
  const existing = await tx.projectTag.findMany({
    where: { projectId },
    select: { tagId: true },
  });

  const current = new Set(existing.map((row) => row.tagId));
  const next = new Set(tagIds);

  const toAdd = tagIds.filter((id) => !current.has(id));
  const toRemove = [...current].filter((id) => !next.has(id));

  if (toRemove.length > 0) {
    await tx.projectTag.deleteMany({ where: { projectId, tagId: { in: toRemove } } });
    await tx.tag.updateMany({
      where: { id: { in: toRemove }, usageCount: { gt: 0 } },
      data: { usageCount: { decrement: 1 } },
    });
  }

  if (toAdd.length > 0) {
    await tx.projectTag.createMany({
      data: toAdd.map((tagId) => ({ projectId, tagId })),
      skipDuplicates: true,
    });
    await tx.tag.updateMany({
      where: { id: { in: toAdd } },
      data: { usageCount: { increment: 1 } },
    });
  }
}

/* ── Derived progress (decision J3) ─────────────────────────────────────── */

/**
 * Serializes a project's milestone mutations against each other.
 *
 * Two milestones completed at the same instant would otherwise each recompute
 * from a snapshot taken before the other committed, and the last writer would
 * store an already-stale figure — four milestones, two completed concurrently,
 * and the project lands on 25% instead of 50%. That is a genuine lost update,
 * and it was reproducible before this lock existed.
 *
 * **It must be the transaction's first statement.** Inserting or deleting a
 * milestone takes a `FOR KEY SHARE` lock on the parent project row through the
 * foreign key; acquiring `FOR UPDATE` *afterwards* is a lock upgrade, and two
 * concurrent transactions each holding SHARE and each wanting EXCLUSIVE
 * deadlock. Taking the exclusive lock up front means the second transaction
 * blocks before it holds anything, so the two serialize instead.
 */
async function lockProject(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
}

/**
 * Recomputes `progressPercent` from the milestone rows.
 *
 * Always called **inside** the transaction that changed a milestone, so the
 * percentage and the roadmap it summarizes commit together. Zero milestones is
 * 0%, not 100% — an empty roadmap is the start of a project, not a finished
 * one.
 *
 * Callers **must** hold the project row lock (see `lockProject`) before
 * invoking this, because it is a read-modify-write rather than an atomic
 * increment and so is not self-serializing the way the like and follow
 * counters are.
 */
export async function recomputeProgress(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<number> {
  // Sequential, not `Promise.all`: both statements run inside the caller's
  // lock on the same connection, and they are two counts on an indexed column.
  const total = await tx.projectMilestone.count({ where: { projectId } });
  const complete = await tx.projectMilestone.count({
    where: { projectId, isComplete: true },
  });

  const percent = total === 0 ? 0 : Math.round((complete / total) * 100);
  await tx.project.update({
    where: { id: projectId },
    data: { progressPercent: percent },
  });

  return percent;
}

/* ── Project writes ─────────────────────────────────────────────────────── */

export interface CreateProjectData {
  ownerId: string;
  title: string;
  description: string;
  techStack: string[];
  gallery: string[];
  status: ProjectStatus;
  fundingStage: FundingStage;
  visibility: Visibility;
  coverImageUrl: string | null;
  demoUrl: string | null;
  repositoryUrl: string | null;
  documentationUrl: string | null;
  tagIds: string[];
}

/** How many slug candidates to try before giving up and surfacing the P2002. */
const MAX_SLUG_ATTEMPTS = 6;

function isSlugConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== "P2002") return false;

  const target = error.meta?.["target"];
  return Array.isArray(target) ? target.includes("slug") : true;
}

/**
 * Creates a project, its owner membership, and its tag links in one
 * transaction, and increments the owner's `projectsCount` (decisions J8, J9).
 *
 * The owner membership is not optional bookkeeping. `Project.ownerId` is the
 * authoritative ownership source, but the seed also creates an `owner`
 * membership row and later phases read the membership table for access checks;
 * creating one without the other is exactly the drift J8 forbids.
 *
 * Slug collisions are resolved by **retrying the whole transaction** with the
 * next candidate rather than by looping inside it. A `P2002` aborts the
 * surrounding transaction in Postgres, so an in-transaction retry would run
 * every subsequent statement in a failed transaction block.
 */
export async function createProject(data: CreateProjectData): Promise<ProjectDetailRow> {
  const base = initialSlugFor(data.title);
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    const slug = slugCandidate(base, attempt);

    try {
      return await prisma.$transaction(async (tx) => {
        const created = await tx.project.create({
          data: {
            slug,
            ownerId: data.ownerId,
            title: data.title,
            description: data.description,
            techStack: data.techStack,
            gallery: data.gallery,
            status: data.status,
            fundingStage: data.fundingStage,
            visibility: data.visibility,
            coverImageUrl: data.coverImageUrl,
            demoUrl: data.demoUrl,
            repositoryUrl: data.repositoryUrl,
            documentationUrl: data.documentationUrl,
            members: { create: [{ userId: data.ownerId, role: "owner" }] },
          },
          select: { id: true },
        });

        if (data.tagIds.length > 0) {
          await applyTagSet(tx, created.id, data.tagIds);
        }

        await tx.user.update({
          where: { id: data.ownerId },
          data: { projectsCount: { increment: 1 } },
        });

        return tx.project.findUniqueOrThrow({
          where: { id: created.id },
          select: projectDetailSelect,
        });
      });
    } catch (error) {
      if (!isSlugConflict(error)) throw error;
      lastError = error;
    }
  }

  throw lastError;
}

export interface UpdateProjectData {
  title?: string | undefined;
  description?: string | undefined;
  techStack?: string[] | undefined;
  gallery?: string[] | undefined;
  status?: ProjectStatus | undefined;
  fundingStage?: FundingStage | undefined;
  visibility?: Visibility | undefined;
  coverImageUrl?: string | null | undefined;
  demoUrl?: string | null | undefined;
  repositoryUrl?: string | null | undefined;
  documentationUrl?: string | null | undefined;
}

/**
 * Applies a patch. `slug` is absent from `UpdateProjectData` by design —
 * renaming would break every existing link (decision J2).
 */
export async function updateProject(
  projectId: string,
  data: UpdateProjectData,
  tagIds: string[] | undefined,
): Promise<ProjectDetailRow> {
  return prisma.$transaction(async (tx) => {
    const patch: Prisma.ProjectUpdateInput = {};
    if (data.title !== undefined) patch.title = data.title;
    if (data.description !== undefined) patch.description = data.description;
    if (data.techStack !== undefined) patch.techStack = data.techStack;
    if (data.gallery !== undefined) patch.gallery = data.gallery;
    if (data.status !== undefined) patch.status = data.status;
    if (data.fundingStage !== undefined) patch.fundingStage = data.fundingStage;
    if (data.visibility !== undefined) patch.visibility = data.visibility;
    if (data.coverImageUrl !== undefined) patch.coverImageUrl = data.coverImageUrl;
    if (data.demoUrl !== undefined) patch.demoUrl = data.demoUrl;
    if (data.repositoryUrl !== undefined) patch.repositoryUrl = data.repositoryUrl;
    if (data.documentationUrl !== undefined) {
      patch.documentationUrl = data.documentationUrl;
    }

    if (Object.keys(patch).length > 0) {
      await tx.project.update({ where: { id: projectId }, data: patch });
    }

    if (tagIds !== undefined) {
      await applyTagSet(tx, projectId, tagIds);
    }

    return tx.project.findUniqueOrThrow({
      where: { id: projectId },
      select: projectDetailSelect,
    });
  });
}

/**
 * Soft delete (decision J9).
 *
 * The `deletedAt: null` guard on `updateMany` is what makes the owner's
 * `projectsCount` decrement safe: a repeated delete matches zero rows, so the
 * counter cannot be driven below the number of projects that actually exist.
 * Same discipline as gating an unfollow's decrement on a row being removed.
 */
export async function softDeleteProject(
  projectId: string,
  ownerId: string,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const removed = await tx.project.updateMany({
      where: { id: projectId, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    if (removed.count === 0) return false;

    await tx.user.update({
      where: { id: ownerId },
      data: { projectsCount: { decrement: removed.count } },
    });

    return true;
  });
}

/**
 * Ownership transfer (decision J8) — one transaction covering all four
 * consequences, so neither source of ownership can be left stale:
 *
 *   1. `Project.ownerId` moves.
 *   2. The new owner's membership is created or promoted to `owner`.
 *   3. The previous owner is demoted to `collaborator` rather than removed —
 *      dropping them would erase their contribution history from the team list.
 *   4. Both users' `projectsCount` follow the project.
 */
export async function transferOwnership(
  projectId: string,
  fromUserId: string,
  toUserId: string,
): Promise<ProjectDetailRow> {
  return prisma.$transaction(async (tx) => {
    await tx.project.update({ where: { id: projectId }, data: { ownerId: toUserId } });

    await tx.projectMember.upsert({
      where: { projectId_userId: { projectId, userId: toUserId } },
      create: { projectId, userId: toUserId, role: "owner" },
      update: { role: "owner" },
    });

    await tx.projectMember.updateMany({
      where: { projectId, userId: fromUserId },
      data: { role: "collaborator" },
    });

    await tx.user.update({
      where: { id: toUserId },
      data: { projectsCount: { increment: 1 } },
    });
    await tx.user.update({
      where: { id: fromUserId },
      data: { projectsCount: { decrement: 1 } },
    });

    return tx.project.findUniqueOrThrow({
      where: { id: projectId },
      select: projectDetailSelect,
    });
  });
}

/* ── Member writes ──────────────────────────────────────────────────────── */

/** Throws Prisma `P2002` when the user is already a member; the service maps it. */
export async function addMember(
  projectId: string,
  userId: string,
  role: ProjectMemberRole,
): Promise<ProjectMemberRow> {
  return prisma.projectMember.create({
    data: { projectId, userId, role },
    select: memberSelect,
  });
}

export async function updateMemberRole(
  projectId: string,
  userId: string,
  role: ProjectMemberRole,
): Promise<ProjectMemberRow> {
  return prisma.projectMember.update({
    where: { projectId_userId: { projectId, userId } },
    data: { role },
    select: memberSelect,
  });
}

export async function removeMember(projectId: string, userId: string): Promise<boolean> {
  const removed = await prisma.projectMember.deleteMany({ where: { projectId, userId } });
  return removed.count > 0;
}

/* ── Milestone writes (each recomputes progress) ────────────────────────── */

export interface CreateMilestoneData {
  title: string;
  description: string;
  isComplete: boolean;
  targetDate: Date | null;
  position: number | undefined;
}

export async function createMilestone(
  projectId: string,
  data: CreateMilestoneData,
): Promise<{ milestone: MilestoneRow; progressPercent: number }> {
  return prisma.$transaction(async (tx) => {
    await lockProject(tx, projectId);

    const position =
      data.position ?? (await tx.projectMilestone.count({ where: { projectId } }));

    const milestone = await tx.projectMilestone.create({
      data: {
        projectId,
        title: data.title,
        description: data.description,
        isComplete: data.isComplete,
        completedAt: data.isComplete ? new Date() : null,
        targetDate: data.targetDate,
        position,
      },
      select: milestoneSelect,
    });

    const progressPercent = await recomputeProgress(tx, projectId);
    return { milestone, progressPercent };
  });
}

export interface UpdateMilestoneData {
  title?: string | undefined;
  description?: string | undefined;
  isComplete?: boolean | undefined;
  targetDate?: Date | null | undefined;
  position?: number | undefined;
}

/**
 * `completedAt` is maintained here rather than accepted from a client: it is a
 * fact about when the flag flipped, and letting a caller assert it would make
 * the roadmap's history editable.
 */
export async function updateMilestone(
  projectId: string,
  milestoneId: string,
  data: UpdateMilestoneData,
): Promise<{ milestone: MilestoneRow; progressPercent: number }> {
  return prisma.$transaction(async (tx) => {
    await lockProject(tx, projectId);

    const current = await tx.projectMilestone.findFirstOrThrow({
      where: { id: milestoneId, projectId },
      select: { isComplete: true },
    });

    const patch: Prisma.ProjectMilestoneUpdateInput = {};
    if (data.title !== undefined) patch.title = data.title;
    if (data.description !== undefined) patch.description = data.description;
    if (data.targetDate !== undefined) patch.targetDate = data.targetDate;
    if (data.position !== undefined) patch.position = data.position;

    if (data.isComplete !== undefined && data.isComplete !== current.isComplete) {
      patch.isComplete = data.isComplete;
      patch.completedAt = data.isComplete ? new Date() : null;
    }

    const milestone = await tx.projectMilestone.update({
      where: { id: milestoneId },
      data: patch,
      select: milestoneSelect,
    });

    const progressPercent = await recomputeProgress(tx, projectId);
    return { milestone, progressPercent };
  });
}

export async function deleteMilestone(
  projectId: string,
  milestoneId: string,
): Promise<{ removed: boolean; progressPercent: number }> {
  return prisma.$transaction(async (tx) => {
    await lockProject(tx, projectId);

    const removed = await tx.projectMilestone.deleteMany({
      where: { id: milestoneId, projectId },
    });

    const progressPercent = await recomputeProgress(tx, projectId);
    return { removed: removed.count > 0, progressPercent };
  });
}

/* ── Update (changelog) writes ──────────────────────────────────────────── */

export async function createUpdate(
  projectId: string,
  authorId: string,
  content: string,
): Promise<ProjectUpdateRow> {
  return prisma.projectUpdate.create({
    data: { projectId, authorId, content },
    select: updateSelect,
  });
}

export async function editUpdate(
  updateId: string,
  content: string,
): Promise<ProjectUpdateRow> {
  return prisma.projectUpdate.update({
    where: { id: updateId },
    data: { content },
    select: updateSelect,
  });
}

export async function softDeleteUpdate(updateId: string): Promise<boolean> {
  const removed = await prisma.projectUpdate.updateMany({
    where: { id: updateId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  return removed.count > 0;
}

/* ── Engagement counters ────────────────────────────────────────────────── */

/**
 * Likes and follows share one shape, and it is the Phase 4 follow shape:
 *
 *   - The **composite primary key is the arbiter.** Simultaneous identical
 *     likes all attempt the insert; exactly one commits and the rest raise
 *     `P2002` and roll back, including their counter increments.
 *   - **`{ increment: 1 }` compiles to `SET x = x + 1`** under a row lock, so
 *     two *different* likers serialize instead of losing an update.
 *   - **Decrements gate on a row actually being deleted**, which is what lets
 *     unlike be idempotent without driving the counter negative.
 *
 * Throws `P2002` on a duplicate; the service maps it to a conflict.
 */
export async function likeProject(projectId: string, userId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.projectLike.create({ data: { projectId, userId } });
    await tx.project.update({
      where: { id: projectId },
      data: { likesCount: { increment: 1 } },
    });
  });
}

export async function unlikeProject(projectId: string, userId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const removed = await tx.projectLike.deleteMany({ where: { projectId, userId } });
    if (removed.count === 0) return false;

    await tx.project.update({
      where: { id: projectId },
      data: { likesCount: { decrement: removed.count } },
    });
    return true;
  });
}

export async function followProject(projectId: string, userId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.projectFollower.create({ data: { projectId, userId } });
    await tx.project.update({
      where: { id: projectId },
      data: { followersCount: { increment: 1 } },
    });
  });
}

export async function unfollowProject(
  projectId: string,
  userId: string,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const removed = await tx.projectFollower.deleteMany({ where: { projectId, userId } });
    if (removed.count === 0) return false;

    await tx.project.update({
      where: { id: projectId },
      data: { followersCount: { decrement: removed.count } },
    });
    return true;
  });
}

/** Views are deduplicated in Redis before they reach here (decision J6). */
export async function incrementViews(projectId: string): Promise<number> {
  const row = await prisma.project.update({
    where: { id: projectId },
    data: { viewsCount: { increment: 1 } },
    select: { viewsCount: true },
  });
  return row.viewsCount;
}

/** Counter read, used by the engagement responses and by the tests. */
export async function readCounters(
  projectId: string,
): Promise<{ viewsCount: number; likesCount: number; followersCount: number } | null> {
  return prisma.project.findUnique({
    where: { id: projectId },
    select: { viewsCount: true, likesCount: true, followersCount: true },
  });
}

export {
  memberSelect,
  milestoneSelect,
  projectDetailSelect,
  trendingSelect,
  updateSelect,
};
