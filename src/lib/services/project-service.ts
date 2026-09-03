import type {
  FundingStage,
  Milestone,
  Project,
  ProjectMemberRole,
  ProjectMemberWithUser,
  ProjectMetrics,
  ProjectStatus,
  ProjectUpdateWithAuthor,
  TrendingProjectSummary,
} from "@/types";
import { ApiError, api, type OffsetPage } from "@/lib/api";

/**
 * Projects (`backend/src/modules/projects`).
 *
 * The backend's `ProjectView` was written to mirror the frontend's `Project`
 * field for field and then add to it, so there is no adapter here — only the
 * envelope keys (`{ project }`, `{ projects }`, `{ member }`) being unwrapped.
 *
 * Two things this module deliberately does not do: it does not invent a
 * discussion endpoint (none exists), and it does not pretend a pin is stored
 * anywhere. Both are explained where they occur.
 */

/** Extras the backend returns beyond the shipped `Project` type. */
export interface ProjectDetail extends Project {
  visibility: "public" | "private" | "unlisted";
  owner: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    builderRank: string;
  };
}

/**
 * The viewer's relationship to a project, so the page can render Like/Follow
 * and the edit affordances without re-deriving permissions client-side.
 * Null for anonymous viewers.
 */
export interface ProjectViewerState {
  isOwner: boolean;
  isMember: boolean;
  role: ProjectMemberRole | null;
  hasLiked: boolean;
  isFollowing: boolean;
  canEdit: boolean;
  canManageMembers: boolean;
}

export interface ProjectResult {
  project: ProjectDetail;
  viewer: ProjectViewerState | null;
}

/** Sort keys the backend accepts; each maps to an indexed column. */
export type ProjectSort = "recent" | "trending" | "progress" | "updated";

export interface ProjectListParams {
  page?: number;
  limit?: number;
  sort?: ProjectSort;
  status?: ProjectStatus;
  tag?: string;
  tech?: string;
}

/* ── Reads ────────────────────────────────────────────────────────────────── */

/**
 * `GET /projects` — offset-paginated discovery.
 *
 * Offset, not cursor: `api.getPaginated` keeps the envelope's `pagination`
 * sibling, which a plain `api.get` would drop. See `lib/api/client.ts`.
 */
export async function getProjects(
  params: ProjectListParams = {},
): Promise<OffsetPage<ProjectDetail>> {
  return api.getPaginated<ProjectDetail>("/projects", { query: { ...params } });
}

/**
 * `GET /projects/{slug}`.
 *
 * A 404 becomes `null`. As with profiles, the backend answers 404 — never
 * 403 — for a project that exists but is private to this viewer, and the
 * frontend must not try to tell the two apart.
 */
export async function getProjectBySlug(slug: string): Promise<ProjectResult | null> {
  try {
    return await api.get<ProjectResult>(`/projects/${encodeURIComponent(slug)}`);
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) return null;
    throw error;
  }
}

/** `GET /users/{username}/projects` — the profile's project grid. */
export async function getProjectsByOwner(
  username: string,
  params: { page?: number; limit?: number; sort?: ProjectSort } = {},
): Promise<OffsetPage<ProjectDetail>> {
  return api.getPaginated<ProjectDetail>(
    `/users/${encodeURIComponent(username)}/projects`,
    { query: { ...params } },
  );
}

/**
 * The profile's highlighted grid.
 *
 * **There is no pin state anywhere** — not in the backend, and not in the
 * frontend before this phase either; the shipped mock already sorted by likes
 * and said so. `sort=trending` is the backend's likes-descending order, so
 * this is the same honest "their best work" list, now computed from real
 * data. The card that renders it is titled accordingly rather than claiming a
 * pin the user never made.
 */
export async function getTopProjects(username: string, limit = 3): Promise<Project[]> {
  const page = await getProjectsByOwner(username, { sort: "trending", limit });
  return page.items;
}

/** `GET /projects/trending` — the dashboard widget's short list. */
export async function getTrendingProjects(limit = 5): Promise<TrendingProjectSummary[]> {
  const { projects } = await api.get<{ projects: TrendingProjectSummary[] }>(
    "/projects/trending",
    { query: { limit } },
  );
  return projects;
}

/** `GET /projects/{slug}/members` — the joined list, so no client-side join. */
export async function getProjectMembers(slug: string): Promise<ProjectMemberWithUser[]> {
  const page = await api.getPaginated<ProjectMemberWithUser>(
    `/projects/${encodeURIComponent(slug)}/members`,
    { query: { limit: 50 } },
  );
  return page.items;
}

export interface ProjectUpdatePage {
  updates: ProjectUpdateWithAuthor[];
  nextCursor: string | null;
}

/** `GET /projects/{slug}/updates` — the project changelog, cursor-paginated. */
export async function getProjectUpdates(
  slug: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<ProjectUpdatePage> {
  return api.get<ProjectUpdatePage>(`/projects/${encodeURIComponent(slug)}/updates`, {
    query: { cursor: options.cursor, limit: options.limit },
  });
}

/** `GET /projects/{slug}/milestones` — the roadmap. */
export async function getProjectMilestones(slug: string): Promise<Milestone[]> {
  const { milestones } = await api.get<{ milestones: Milestone[] }>(
    `/projects/${encodeURIComponent(slug)}/milestones`,
  );
  return milestones;
}

/* ── Writes ───────────────────────────────────────────────────────────────── */

export interface ProjectDraft {
  title: string;
  description?: string;
  techStack?: string[];
  tags?: string[];
  status?: ProjectStatus;
  /**
   * Present because the project page renders it (`PROJECT_FUNDING_META`) and
   * `createProjectSchema` accepts it. Omitting it from the draft would have
   * left the create form unable to set a field the detail view displays.
   */
  fundingStage?: FundingStage;
  visibility?: "public" | "private" | "unlisted";
  demoUrl?: string | null;
  repositoryUrl?: string | null;
  documentationUrl?: string | null;
}

export async function createProject(draft: ProjectDraft): Promise<ProjectDetail> {
  const { project } = await api.post<{ project: ProjectDetail }>("/projects", draft);
  return project;
}

export async function updateProject(
  slug: string,
  patch: Partial<ProjectDraft>,
): Promise<ProjectDetail> {
  const { project } = await api.patch<{ project: ProjectDetail }>(
    `/projects/${encodeURIComponent(slug)}`,
    patch,
  );
  return project;
}

export async function deleteProject(slug: string): Promise<void> {
  await api.delete(`/projects/${encodeURIComponent(slug)}`);
}

/* ── Engagement ───────────────────────────────────────────────────────────── */

/** Every engagement call returns the refreshed counters, so nothing is guessed. */
export interface ProjectLikeResult {
  liked: boolean;
  metrics: ProjectMetrics;
}

export interface ProjectFollowResult {
  following: boolean;
  metrics: ProjectMetrics;
}

export async function likeProject(slug: string): Promise<ProjectLikeResult> {
  return api.post<ProjectLikeResult>(`/projects/${encodeURIComponent(slug)}/like`);
}

export async function unlikeProject(slug: string): Promise<ProjectLikeResult> {
  return api.delete<ProjectLikeResult>(`/projects/${encodeURIComponent(slug)}/like`);
}

export async function followProject(slug: string): Promise<ProjectFollowResult> {
  return api.post<ProjectFollowResult>(`/projects/${encodeURIComponent(slug)}/follow`);
}

export async function unfollowProject(slug: string): Promise<ProjectFollowResult> {
  return api.delete<ProjectFollowResult>(`/projects/${encodeURIComponent(slug)}/follow`);
}

/**
 * `POST /projects/{slug}/view` — the backend de-duplicates per viewer, and
 * answers `{ counted: false }` when this view did not move the counter.
 */
export async function recordProjectView(
  slug: string,
): Promise<{ counted: boolean; metrics: ProjectMetrics }> {
  return api.post(`/projects/${encodeURIComponent(slug)}/view`);
}

/* ── Members ──────────────────────────────────────────────────────────────── */

export async function addProjectMember(
  slug: string,
  username: string,
  role: Exclude<ProjectMemberRole, "owner"> = "contributor",
): Promise<ProjectMemberWithUser> {
  const { member } = await api.post<{ member: ProjectMemberWithUser }>(
    `/projects/${encodeURIComponent(slug)}/members`,
    { username, role },
  );
  return member;
}

export async function updateProjectMemberRole(
  slug: string,
  username: string,
  role: Exclude<ProjectMemberRole, "owner">,
): Promise<ProjectMemberWithUser> {
  const { member } = await api.patch<{ member: ProjectMemberWithUser }>(
    `/projects/${encodeURIComponent(slug)}/members/${encodeURIComponent(username)}`,
    { role },
  );
  return member;
}

export async function removeProjectMember(slug: string, username: string): Promise<void> {
  await api.delete(
    `/projects/${encodeURIComponent(slug)}/members/${encodeURIComponent(username)}`,
  );
}
