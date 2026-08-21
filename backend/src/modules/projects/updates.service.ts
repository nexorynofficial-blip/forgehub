import { AppError } from "../../utils/errors.js";
import { buildCursorPage } from "../../utils/pagination.js";
import { canModifyUpdate } from "./project.access.js";
import { toProjectUpdateWithAuthor } from "./project.view.js";
import * as repo from "./projects.repository.js";
import {
  assertCan,
  loadVisibleProject,
  type Actor,
  type Viewer,
} from "./projects.service.js";
import type { CreateUpdateInput, EditUpdateInput } from "./projects.schema.js";
import type { ProjectUpdateWithAuthorView } from "./projects.types.js";

/**
 * The project changelog (BACKEND_PRD.md §6 "Updates").
 *
 * Distinct from the feed: `project-updates.tsx` calls these "the project's own
 * record", while milestone announcements in the social feed are Phase 6 posts.
 * They share a `Post.projectId` linkage in the schema, but Phase 5 writes only
 * `ProjectUpdate` rows and creates no posts.
 *
 * Cursor-paginated rather than offset, because this is the one project
 * collection that grows without bound and is read newest-first —
 * `project_updates(projectId, createdAt DESC)` exists for exactly this query.
 */

export interface UpdatePage {
  updates: ProjectUpdateWithAuthorView[];
  nextCursor: string | null;
}

export async function list(
  slug: string,
  viewer: Viewer,
  query: { cursor?: string | undefined; limit: number },
): Promise<UpdatePage> {
  const context = await loadVisibleProject(slug, viewer);

  const rows = await repo.listUpdates(context.row.id, query.cursor, query.limit);
  const page = buildCursorPage(rows, query.limit, (row) => row.id);

  return {
    updates: page.items.map(toProjectUpdateWithAuthor),
    nextCursor: page.nextCursor,
  };
}

export async function create(
  slug: string,
  actor: Actor,
  input: CreateUpdateInput,
): Promise<ProjectUpdateWithAuthorView> {
  const context = await loadVisibleProject(slug, actor);
  assertCan("create_update", context, "Only the project team can post updates");

  // The author is the verified actor, never a body field.
  const row = await repo.createUpdate(context.row.id, actor.id, input.content);

  // No notification is emitted here. `project_update` is a fan-out to every
  // project follower, and the notification port is single-recipient by design
  // — looping over followers in this service would put delivery fan-out in the
  // domain layer. Phase 9 owns it. See `ports/notification.port.ts`.

  return toProjectUpdateWithAuthor(row);
}

/**
 * Loads an update scoped to its project, so an id from another project cannot
 * be reached by someone holding write access to *some* project.
 */
async function loadUpdate(projectId: string, updateId: string) {
  const row = await repo.findUpdate(updateId, projectId);
  if (!row) {
    throw AppError.notFound("Update not found");
  }
  return row;
}

/**
 * Authorship is checked separately from role: a contributor holds no
 * `moderate_updates` grant but must still be able to fix their own typo.
 */
function assertCanModify(
  context: Awaited<ReturnType<typeof loadVisibleProject>>,
  actorId: string,
  authorId: string,
): void {
  if (!canModifyUpdate({ ...context.access, isAuthor: authorId === actorId })) {
    throw AppError.authorization("You can only edit your own updates");
  }
}

export async function edit(
  slug: string,
  actor: Actor,
  updateId: string,
  input: EditUpdateInput,
): Promise<ProjectUpdateWithAuthorView> {
  const context = await loadVisibleProject(slug, actor);
  const existing = await loadUpdate(context.row.id, updateId);

  assertCanModify(context, actor.id, existing.authorId);

  const row = await repo.editUpdate(updateId, input.content);
  return toProjectUpdateWithAuthor(row);
}

export async function remove(
  slug: string,
  actor: Actor,
  updateId: string,
): Promise<{ deleted: boolean }> {
  const context = await loadVisibleProject(slug, actor);
  const existing = await loadUpdate(context.row.id, updateId);

  assertCanModify(context, actor.id, existing.authorId);

  // Soft delete: `ProjectUpdate.deletedAt` exists because updates are content,
  // and DATABASE.md's rule is that deleting content must not destroy history.
  const deleted = await repo.softDeleteUpdate(updateId);
  return { deleted };
}
