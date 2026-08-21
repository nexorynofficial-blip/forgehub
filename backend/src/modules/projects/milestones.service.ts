import { AppError } from "../../utils/errors.js";
import { toMilestone } from "./project.view.js";
import * as repo from "./projects.repository.js";
import {
  assertCan,
  loadVisibleProject,
  type Actor,
  type Viewer,
} from "./projects.service.js";
import type { CreateMilestoneInput, UpdateMilestoneInput } from "./projects.schema.js";
import type { MilestoneView } from "./projects.types.js";

/**
 * The project roadmap (BACKEND_PRD.md §6).
 *
 * Every method enters through `loadVisibleProject`, which is what makes the
 * milestone endpoints inherit the project's privacy rules for free: a private
 * project's roadmap 404s exactly as the project does, and a blocked viewer
 * cannot reach it through this side door.
 *
 * `progressPercent` is returned alongside each mutation because it is derived
 * from these rows (decision J3) and will have changed — the client should not
 * have to re-fetch the project to learn its new completion figure.
 */

export interface MilestoneMutationResult {
  milestone: MilestoneView;
  /** Recomputed inside the same transaction as the milestone write. */
  progressPercent: number;
}

export async function list(slug: string, viewer: Viewer): Promise<MilestoneView[]> {
  const context = await loadVisibleProject(slug, viewer);
  const rows = await repo.listMilestones(context.row.id);

  return rows.map(toMilestone);
}

export async function create(
  slug: string,
  actor: Actor,
  input: CreateMilestoneInput,
): Promise<MilestoneMutationResult> {
  const context = await loadVisibleProject(slug, actor);
  assertCan("manage_milestones", context, "You cannot edit this project's roadmap");

  const { milestone, progressPercent } = await repo.createMilestone(context.row.id, {
    title: input.title,
    description: input.description ?? "",
    isComplete: input.isComplete ?? false,
    targetDate: input.targetDate ?? null,
    position: input.position,
  });

  return { milestone: toMilestone(milestone), progressPercent };
}

export async function update(
  slug: string,
  actor: Actor,
  milestoneId: string,
  input: UpdateMilestoneInput,
): Promise<MilestoneMutationResult> {
  const context = await loadVisibleProject(slug, actor);
  assertCan("manage_milestones", context, "You cannot edit this project's roadmap");

  // Scoped to the project, so a milestone id from another project cannot be
  // edited by anyone who happens to hold write access to *some* project.
  const existing = await repo.findMilestone(milestoneId, context.row.id);
  if (!existing) {
    throw AppError.notFound("Milestone not found");
  }

  const { milestone, progressPercent } = await repo.updateMilestone(
    context.row.id,
    milestoneId,
    {
      title: input.title,
      description: input.description,
      isComplete: input.isComplete,
      targetDate: input.targetDate,
      position: input.position,
    },
  );

  return { milestone: toMilestone(milestone), progressPercent };
}

export async function remove(
  slug: string,
  actor: Actor,
  milestoneId: string,
): Promise<{ deleted: boolean; progressPercent: number }> {
  const context = await loadVisibleProject(slug, actor);
  assertCan("manage_milestones", context, "You cannot edit this project's roadmap");

  const { removed, progressPercent } = await repo.deleteMilestone(
    context.row.id,
    milestoneId,
  );

  if (!removed) {
    throw AppError.notFound("Milestone not found");
  }

  return { deleted: true, progressPercent };
}
