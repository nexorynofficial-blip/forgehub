import { notificationPort } from "../../ports/notification.port.js";
import { AuditAction, recordAuditEvent, type AuditContext } from "../../utils/audit.js";
import { AppError } from "../../utils/errors.js";
import { buildPagination } from "../../utils/pagination.js";
import type { Pagination } from "../../utils/response.js";
import * as usersRepo from "../users/users.repository.js";
import { toProjectMemberWithUser } from "./project.view.js";
import * as repo from "./projects.repository.js";
import {
  assertCan,
  isUniqueViolation,
  loadVisibleProject,
  type Actor,
  type Viewer,
} from "./projects.service.js";
import type { AddMemberInput, UpdateMemberRoleInput } from "./projects.schema.js";
import type { ProjectMemberWithUserView } from "./projects.types.js";

/**
 * Project collaboration (BACKEND_PRD.md §7).
 *
 * One rule dominates this file: **membership may never contradict
 * `Project.ownerId`** (decision J8). `ownerId` is the authoritative ownership
 * source, and the `owner` membership row exists alongside it because later
 * phases read the membership table for access checks. Any write that could put
 * the two out of step is refused here and routed to
 * `POST /projects/:slug/transfer`, which moves both in one transaction.
 */

export interface MemberListResult {
  members: ProjectMemberWithUserView[];
  pagination: Pagination;
}

export async function list(
  slug: string,
  viewer: Viewer,
  query: { page: number; limit: number },
): Promise<MemberListResult> {
  const context = await loadVisibleProject(slug, viewer);

  const { rows, total } = await repo.findMembers(
    context.row.id,
    (query.page - 1) * query.limit,
    query.limit,
  );

  return {
    members: rows.map(toProjectMemberWithUser),
    pagination: buildPagination({ page: query.page, limit: query.limit }, total),
  };
}

/**
 * The guard that keeps the two ownership records in step.
 *
 * `owner` is a legal value in the assignable enum (decision J4) — it is what
 * the transfer flow writes — but accepting it *here* would create a second
 * owner membership on a project whose `ownerId` still names someone else.
 * A 422 pointing at the right endpoint is better than silently producing the
 * drift J8 forbids.
 */
function refuseOwnerRole(role: string, field: string): void {
  if (role !== "owner") return;

  throw AppError.validation("Ownership is transferred, not assigned", [
    {
      field,
      message:
        "Use POST /projects/:slug/transfer to change the owner — it moves Project.ownerId and both memberships together.",
    },
  ]);
}

export async function add(
  slug: string,
  actor: Actor,
  input: AddMemberInput,
  auditContext: AuditContext,
): Promise<ProjectMemberWithUserView> {
  const context = await loadVisibleProject(slug, actor);
  assertCan("manage_members", context, "You cannot manage this project's team");
  refuseOwnerRole(input.role, "role");

  const target = await usersRepo.findByUsername(input.username);
  if (!target) {
    throw AppError.notFound("User not found");
  }

  try {
    const member = await repo.addMember(context.row.id, target.id, input.role);

    await recordAuditEvent({
      ...auditContext,
      actorId: actor.id,
      action: AuditAction.PROJECT_MEMBER_ADDED,
      targetType: "project",
      targetId: context.row.id,
      metadata: { memberId: target.id, role: input.role },
    });

    // Phase 9 turned this into a real notification row and socket event. The
    // only change activation required was `subject`: the message is rendered at
    // write time, and without the project's own title it would read "added you
    // to the project." with nothing after it.
    await notificationPort.emit({
      recipientId: target.id,
      actorId: actor.id,
      type: "project_invite",
      entityType: "project",
      entityId: context.row.id,
      subject: context.row.title,
    });

    return toProjectMemberWithUser(member);
  } catch (error) {
    // The `@@unique([projectId, userId])` index is the real arbiter; this
    // turns the race between two simultaneous adds into a clean 409.
    if (isUniqueViolation(error)) {
      throw AppError.conflict("That user is already a member of this project");
    }
    throw error;
  }
}

export async function updateRole(
  slug: string,
  actor: Actor,
  username: string,
  input: UpdateMemberRoleInput,
  auditContext: AuditContext,
): Promise<ProjectMemberWithUserView> {
  const context = await loadVisibleProject(slug, actor);
  assertCan("manage_members", context, "You cannot manage this project's team");
  refuseOwnerRole(input.role, "role");

  const target = await usersRepo.findByUsername(username);
  if (!target) {
    throw AppError.notFound("User not found");
  }

  // Demoting the owner of record would leave `ownerId` pointing at someone the
  // membership table says is a contributor — the other half of the drift.
  if (target.id === context.row.ownerId) {
    throw AppError.validation("The project owner's role cannot be changed", [
      {
        field: "role",
        message: "Transfer ownership first; the previous owner is demoted automatically.",
      },
    ]);
  }

  const existing = await repo.findMemberRole(context.row.id, target.id);
  if (existing === null) {
    throw AppError.notFound("That user is not a member of this project");
  }

  const member = await repo.updateMemberRole(context.row.id, target.id, input.role);

  await recordAuditEvent({
    ...auditContext,
    actorId: actor.id,
    action: AuditAction.PROJECT_MEMBER_ROLE_CHANGED,
    targetType: "project",
    targetId: context.row.id,
    metadata: { memberId: target.id, from: existing, to: input.role },
  });

  return toProjectMemberWithUser(member);
}

/**
 * Removes a member, or lets one leave.
 *
 * Leaving is deliberately not a separate endpoint: it is the same row being
 * deleted, and the only difference is who is allowed to do it. A member may
 * always remove *themselves*; removing anyone else needs `manage_members`.
 */
export async function remove(
  slug: string,
  actor: Actor,
  username: string,
  auditContext: AuditContext,
): Promise<{ removed: boolean }> {
  const context = await loadVisibleProject(slug, actor);

  const target = await usersRepo.findByUsername(username);
  if (!target) {
    throw AppError.notFound("User not found");
  }

  const isSelf = target.id === actor.id;
  if (!isSelf) {
    assertCan("manage_members", context, "You cannot manage this project's team");
  }

  // The owner cannot leave or be removed: `Project.owner` is `onDelete:
  // Restrict` and `ownerId` would still name them, so the membership table
  // would contradict the column.
  if (target.id === context.row.ownerId) {
    throw AppError.validation("The project owner cannot leave the project", [
      {
        field: "username",
        message: "Transfer ownership to another member first.",
      },
    ]);
  }

  const removed = await repo.removeMember(context.row.id, target.id);
  if (!removed) {
    throw AppError.notFound("That user is not a member of this project");
  }

  await recordAuditEvent({
    ...auditContext,
    actorId: actor.id,
    action: AuditAction.PROJECT_MEMBER_REMOVED,
    targetType: "project",
    targetId: context.row.id,
    metadata: { memberId: target.id, self: isSelf },
  });

  return { removed: true };
}
