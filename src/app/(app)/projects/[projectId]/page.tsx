import type { Metadata } from "next";

import { ProjectView } from "@/components/project/project-view";

interface ProjectPageProps {
  params: Promise<{ projectId: string }>;
}

/**
 * The `[projectId]` segment carries a `Project.slug`, not an id — the backend
 * addresses every project route by slug and refuses a UUID, so the segment
 * name is legacy and the value is correct. Renaming the folder would change
 * every existing link for no behavioural gain.
 *
 * The title is the slug rather than the project's real title: resolving the
 * title here would mean an anonymous server-side request, which for a private
 * project would 404 and for a public one would still cost a round trip the
 * client is about to make anyway. `ProjectView` fetches as the real viewer.
 */
export async function generateMetadata({ params }: ProjectPageProps): Promise<Metadata> {
  const { projectId } = await params;
  return { title: projectId };
}

export default async function ProjectPage({ params }: ProjectPageProps) {
  const { projectId } = await params;
  return <ProjectView slug={projectId} />;
}
