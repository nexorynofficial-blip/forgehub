import type {
  Project,
  ProjectDiscussionComment,
  ProjectMemberWithUser,
  ProjectUpdateWithAuthor,
} from "@/types";
import { resolvePersonById } from "@/lib/mock/people";
import { mockProjectDiscussionByProjectId } from "@/lib/mock/project-discussion";
import { mockProjectUpdatesByProjectId } from "@/lib/mock/project-updates";
import { mockProjects } from "@/lib/mock/projects";

/** Placeholder for the Project API (TRD.md §5). */

export async function getProjectsByOwnerId(ownerId: string): Promise<Project[]> {
  return mockProjects.filter((project) => project.ownerId === ownerId);
}

/** UI_UX.md §8 "Pinned Projects" — no pin/unpin action exists anywhere in
 * PRD.md, so this surfaces the owner's most-liked projects rather than a
 * persisted pin state. See docs/ASSUMPTIONS.md (Phase 05). */
export async function getPinnedProjects(ownerId: string, limit = 3): Promise<Project[]> {
  return mockProjects
    .filter((project) => project.ownerId === ownerId)
    .sort((a, b) => b.metrics.likes - a.metrics.likes)
    .slice(0, limit);
}

export async function getProjectBySlug(slug: string): Promise<Project | null> {
  return mockProjects.find((project) => project.slug === slug) ?? null;
}

/** Joins `Project.members` (userId-only) against the lightweight people
 * directory — same pattern as `NotificationWithActor`/`PostWithAuthor`. The
 * owner (`mockCurrentUser`) isn't in `mock/people.ts`, so it's checked
 * first. Members with no match anywhere are dropped rather than rendered
 * with placeholder text. */
export async function getProjectMembers(
  project: Project,
): Promise<ProjectMemberWithUser[]> {
  return project.members
    .map((member) => {
      const user = resolvePersonById(member.userId);
      return user ? { ...member, user } : null;
    })
    .filter((member): member is ProjectMemberWithUser => member !== null);
}

export async function getProjectUpdates(
  projectId: string,
): Promise<ProjectUpdateWithAuthor[]> {
  return (mockProjectUpdatesByProjectId[projectId] ?? [])
    .map((update) => {
      const author = resolvePersonById(update.authorId);
      return author ? { ...update, author } : null;
    })
    .filter((update): update is ProjectUpdateWithAuthor => update !== null);
}

export async function getProjectDiscussion(
  projectId: string,
): Promise<ProjectDiscussionComment[]> {
  return mockProjectDiscussionByProjectId[projectId] ?? [];
}

export async function addProjectComment(
  projectId: string,
  content: string,
  author: ProjectDiscussionComment["author"],
): Promise<ProjectDiscussionComment> {
  const comment: ProjectDiscussionComment = {
    id: crypto.randomUUID(),
    projectId,
    author,
    content,
    likesCount: 0,
    createdAt: new Date().toISOString(),
  };
  mockProjectDiscussionByProjectId[projectId] = [
    ...(mockProjectDiscussionByProjectId[projectId] ?? []),
    comment,
  ];
  return comment;
}
