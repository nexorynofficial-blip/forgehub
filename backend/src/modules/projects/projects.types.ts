import type {
  FundingStage,
  ProjectMemberRole,
  ProjectStatus,
  Visibility,
} from "@prisma/client";

import type { UserSummaryView } from "../users/users.types.js";

/**
 * Contracts for the projects module.
 *
 * `ProjectView` mirrors the shipped frontend's `Project` type
 * (`src/types/project.ts`) key for key. The project page destructures exactly
 * these names — `metrics.views`, not `viewsCount`; `tags` as a string array,
 * not a relation — so the API has to serve this shape or the finished UI
 * breaks. Two keys are additive (`visibility`, `owner`); extra keys are inert
 * for the shipped components, which is the same superset argument the response
 * envelope already makes.
 */

/**
 * Mirrors the frontend's `ProjectMetrics`. Nested and un-suffixed on purpose:
 * `project-metrics-bar.tsx` reads `project.metrics.views`, while the dashboard's
 * trending widget reads a flat `likesCount` off a *different* type. Both shapes
 * are real contracts, so the projection layer produces both.
 */
export interface ProjectMetricsView {
  views: number;
  likes: number;
  followers: number;
}

/**
 * Mirrors the frontend's `ProjectMember` — **`userId` only, no nested user**.
 * `project-service.getProjectMembers` joins these against a people directory
 * client-side, and `project-hero.tsx` finds the owner with
 * `members.find(m => m.role === "owner")`, so the embedded array must keep this
 * exact shape.
 *
 * `role` is the persisted Prisma value and may be any of the six enum members
 * (decision J4). The frontend's `ROLE_LABEL` map only covers three of them, but
 * misreporting someone's role to make a badge render is not a trade this layer
 * gets to make — authorization state is reported as it is stored.
 */
export interface ProjectMemberView {
  userId: string;
  role: ProjectMemberRole;
  joinedAt: string;
}

/** Mirrors the frontend's `ProjectMemberWithUser` (`src/types/project-page.ts`). */
export interface ProjectMemberWithUserView extends ProjectMemberView {
  user: UserSummaryView;
}

/**
 * Mirrors the frontend's `Milestone`, plus `position` and `completedAt`.
 *
 * The frontend renders milestones in array order with no sort of its own, so
 * the API must emit them ordered by `position` — the ordering contract lives in
 * the response sequence, and `position` is exposed so a client can reorder.
 */
export interface MilestoneView {
  id: string;
  title: string;
  description: string;
  isComplete: boolean;
  targetDate: string | null;
  completedAt: string | null;
  position: number;
}

/** Mirrors the frontend's `ProjectUpdate`. */
export interface ProjectUpdateView {
  id: string;
  projectId: string;
  authorId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

/** Mirrors the frontend's `ProjectUpdateWithAuthor`. */
export interface ProjectUpdateWithAuthorView extends ProjectUpdateView {
  author: UserSummaryView;
}

/** The full project. Served only after the visibility gate resolves to `full`. */
export interface ProjectView {
  id: string;
  slug: string;
  ownerId: string;
  title: string;
  description: string;
  coverImageUrl: string | null;
  gallery: string[];
  techStack: string[];
  /** Flattened from `ProjectTag[] → Tag.name[]`; the frontend types this `string[]`. */
  tags: string[];
  status: ProjectStatus;
  fundingStage: FundingStage;
  /** Derived from milestone completion (decision J3). Never client-writable. */
  progressPercent: number;
  members: ProjectMemberView[];
  milestones: MilestoneView[];
  demoUrl: string | null;
  repositoryUrl: string | null;
  documentationUrl: string | null;
  metrics: ProjectMetricsView;
  createdAt: string;
  updatedAt: string;

  /* ── Additive beyond the frontend's `Project` ──────────────────────────── */

  /** PRD §6 requires public/private/unlisted; the frontend type predates it. */
  visibility: Visibility;
  /** Saves the project page a second request to render the owner byline. */
  owner: UserSummaryView;
}

/**
 * Mirrors the frontend's `TrendingProjectSummary` (`src/types/dashboard.ts`).
 *
 * Note the deliberate divergence from `ProjectView`: a **flat** `likesCount`
 * and a denormalized owner name/avatar rather than a nested summary. This is
 * what the shipped widget reads, so it is what the endpoint serves.
 */
export interface TrendingProjectView {
  id: string;
  slug: string;
  title: string;
  description: string;
  coverImageUrl: string | null;
  techStack: string[];
  ownerName: string;
  ownerAvatarUrl: string | null;
  likesCount: number;
  progressPercent: number;
}

/**
 * Viewer-relative state, so the project page can render the Like / Follow /
 * Edit affordances without a second round trip. The direct analogue of Phase
 * 4's `RelationshipView`.
 *
 * `role` is the viewer's own membership role, or `null` when they are not a
 * member. There is deliberately no field announcing *why* access was granted —
 * a viewer who can see the project does not need to know whether an admin
 * override or a public setting let them in.
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

/** `GET /projects/:slug` — the project plus the caller's relationship to it. */
export interface ProjectLookupResult {
  project: ProjectView;
  /** Null for anonymous viewers: there is no relationship to describe. */
  viewer: ProjectViewerState | null;
}
