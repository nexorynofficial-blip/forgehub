import { toUserSummary } from "../users/user.view.js";
import type {
  MilestoneRow,
  ProjectDetailRow,
  ProjectMemberRow,
  ProjectUpdateRow,
  TrendingProjectRow,
} from "./projects.repository.js";
import type {
  MilestoneView,
  ProjectMemberView,
  ProjectMemberWithUserView,
  ProjectUpdateView,
  ProjectUpdateWithAuthorView,
  ProjectView,
  TrendingProjectView,
} from "./projects.types.js";

/**
 * The projection layer for projects.
 *
 * Nothing outside this file turns a Prisma row into an API response. That is
 * the whole point, and it is the same chokepoint discipline
 * `users/user.view.ts` established: "can this endpoint leak a column it
 * shouldn't?" has one place to check rather than one per controller.
 *
 * Two columns are selected by the repository and deliberately never appear
 * here:
 *
 *   - **`deletedAt`** — read by the visibility gate, but emitting it would let
 *     a client distinguish "soft-deleted" from "never existed", which is
 *     precisely the distinction the 404 exists to erase.
 *   - **`Project.ownerId` on the nested owner summary** — the owner is
 *     projected through `toUserSummary`, which carries no email and no
 *     credential field, rather than through a hand-assembled object.
 *
 * Every projection builds its result **by construction**. None of them starts
 * from a row and deletes keys: an omission list starts leaking the day someone
 * adds a column, whereas adding a field to an explicit shape has to be
 * deliberate.
 */

function toIso(value: Date): string {
  return value.toISOString();
}

function toIsoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/* ── Children ────────────────────────────────────────────────────────────── */

/**
 * The embedded member entry. `userId` only — no nested user — because the
 * shipped `Project.members` is that shape and `project-hero.tsx` reads
 * `members.find(m => m.role === "owner")` off it.
 *
 * `role` is emitted verbatim, including the three enum values the frontend
 * cannot label (decision J4). Reporting a `developer` as a `collaborator` to
 * make a badge render would be lying about authorization state.
 */
export function toProjectMember(row: {
  userId: string;
  role: ProjectMemberView["role"];
  joinedAt: Date;
}): ProjectMemberView {
  return { userId: row.userId, role: row.role, joinedAt: toIso(row.joinedAt) };
}

/** The joined member, for the members endpoint. */
export function toProjectMemberWithUser(
  row: ProjectMemberRow,
): ProjectMemberWithUserView {
  return {
    userId: row.userId,
    role: row.role,
    joinedAt: toIso(row.joinedAt),
    user: toUserSummary(row.user),
  };
}

export function toMilestone(row: MilestoneRow): MilestoneView {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    isComplete: row.isComplete,
    targetDate: toIsoOrNull(row.targetDate),
    completedAt: toIsoOrNull(row.completedAt),
    position: row.position,
  };
}

export function toProjectUpdate(row: ProjectUpdateRow): ProjectUpdateView {
  return {
    id: row.id,
    projectId: row.projectId,
    authorId: row.authorId,
    content: row.content,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export function toProjectUpdateWithAuthor(
  row: ProjectUpdateRow,
): ProjectUpdateWithAuthorView {
  return { ...toProjectUpdate(row), author: toUserSummary(row.author) };
}

/* ── The project ─────────────────────────────────────────────────────────── */

/**
 * The full project.
 *
 * `metrics` is nested and un-suffixed because that is what
 * `project-metrics-bar.tsx` destructures. `tags` is flattened from the
 * `ProjectTag → Tag` relation to the `string[]` the frontend types, using the
 * display name rather than the slug — `project-hero.tsx` renders these as
 * badge labels.
 */
export function toProjectView(row: ProjectDetailRow): ProjectView {
  return {
    id: row.id,
    slug: row.slug,
    ownerId: row.ownerId,
    title: row.title,
    description: row.description,
    coverImageUrl: row.coverImageUrl,
    gallery: row.gallery,
    techStack: row.techStack,
    tags: row.tags.map((entry) => entry.tag.name),
    status: row.status,
    fundingStage: row.fundingStage,
    progressPercent: row.progressPercent,
    members: row.members.map(toProjectMember),
    milestones: row.milestones.map(toMilestone),
    demoUrl: row.demoUrl,
    repositoryUrl: row.repositoryUrl,
    documentationUrl: row.documentationUrl,
    metrics: {
      views: row.viewsCount,
      likes: row.likesCount,
      followers: row.followersCount,
    },
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),

    visibility: row.visibility,
    owner: toUserSummary(row.owner),
  };
}

/**
 * The trending summary. A separate projection rather than a subset of
 * `toProjectView`, because the shipped widget reads a genuinely different
 * shape: flat `likesCount`, and the owner denormalized into two scalar fields.
 */
export function toTrendingProject(row: TrendingProjectRow): TrendingProjectView {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    coverImageUrl: row.coverImageUrl,
    techStack: row.techStack,
    ownerName: row.owner.displayName,
    ownerAvatarUrl: row.owner.profile?.avatarUrl ?? null,
    likesCount: row.likesCount,
    progressPercent: row.progressPercent,
  };
}
