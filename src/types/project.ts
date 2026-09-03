import type { ID, ISODateString } from "./common";

/** PRD.md §4.3 Project Pages */
export type ProjectStatus = "idea" | "in_progress" | "beta" | "launched" | "archived";

export type FundingStage =
  "bootstrapped" | "pre_seed" | "seed" | "series_a_plus" | "not_seeking";

/**
 * The roles the API will *assign*. Membership writes accept only these three
 * (`ASSIGNABLE_MEMBER_ROLES` in the backend).
 */
export type ProjectMemberRole = "owner" | "collaborator" | "contributor";

/**
 * The roles the API can *return*.
 *
 * The persisted enum has six values and the backend emits whichever is stored,
 * verbatim — reporting a `developer` as a `collaborator` to make a badge
 * render would be lying about authorization state. The read type is therefore
 * wider than the write type, and anything labelling a role has to handle all
 * six or it renders an empty badge the first time real data arrives.
 */
export type ProjectMemberRoleValue =
  ProjectMemberRole | "admin" | "developer" | "designer";

export interface ProjectMember {
  userId: ID;
  role: ProjectMemberRoleValue;
  joinedAt: ISODateString;
}

export interface Milestone {
  id: ID;
  title: string;
  description: string;
  isComplete: boolean;
  targetDate: ISODateString | null;
}

export interface ProjectUpdate {
  id: ID;
  projectId: ID;
  authorId: ID;
  content: string;
  createdAt: ISODateString;
}

export interface ProjectMetrics {
  views: number;
  likes: number;
  followers: number;
}

export interface Project {
  id: ID;
  slug: string;
  ownerId: ID;
  title: string;
  description: string;
  coverImageUrl: string | null;
  gallery: string[];
  techStack: string[];
  tags: string[];
  status: ProjectStatus;
  fundingStage: FundingStage;
  progressPercent: number;
  members: ProjectMember[];
  milestones: Milestone[];
  demoUrl: string | null;
  repositoryUrl: string | null;
  documentationUrl: string | null;
  metrics: ProjectMetrics;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}
