import type { ID, ISODateString } from "./common";

/** PRD.md §4.3 Project Pages */
export type ProjectStatus = "idea" | "in_progress" | "beta" | "launched" | "archived";

export type FundingStage =
  "bootstrapped" | "pre_seed" | "seed" | "series_a_plus" | "not_seeking";

export type ProjectMemberRole = "owner" | "collaborator" | "contributor";

export interface ProjectMember {
  userId: ID;
  role: ProjectMemberRole;
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
