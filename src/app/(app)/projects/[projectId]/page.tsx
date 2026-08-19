import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getProjectBySlug } from "@/lib/services/project-service";
import { FadeIn } from "@/components/motion/fade-in";
import { ProjectDiscussion } from "@/components/project/project-discussion";
import { ProjectGallery } from "@/components/project/project-gallery";
import { ProjectHero } from "@/components/project/project-hero";
import { ProjectMetricsBar } from "@/components/project/project-metrics-bar";
import { ProjectRoadmap } from "@/components/project/project-roadmap";
import { ProjectTeam } from "@/components/project/project-team";
import { ProjectUpdates } from "@/components/project/project-updates";

interface ProjectPageProps {
  params: Promise<{ projectId: string }>;
}

/** The `[projectId]` segment is matched against `Project.slug`, not `.id` —
 * see docs/ASSUMPTIONS.md (Phase 07). */
export async function generateMetadata({ params }: ProjectPageProps): Promise<Metadata> {
  const { projectId } = await params;
  const project = await getProjectBySlug(projectId);
  if (!project) return { title: "Project not found" };
  return { title: project.title };
}

export default async function ProjectPage({ params }: ProjectPageProps) {
  const { projectId } = await params;
  const project = await getProjectBySlug(projectId);
  if (!project) notFound();

  return (
    <div className="flex flex-col gap-6 pt-8 pb-8">
      <FadeIn>
        <ProjectHero project={project} />
      </FadeIn>

      <FadeIn delay={0.05}>
        <ProjectMetricsBar project={project} />
      </FadeIn>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <FadeIn delay={0.1}>
            <ProjectRoadmap
              progressPercent={project.progressPercent}
              milestones={project.milestones}
            />
          </FadeIn>
          <FadeIn delay={0.15}>
            <ProjectGallery gallery={project.gallery} />
          </FadeIn>
          <FadeIn delay={0.2}>
            <ProjectUpdates projectId={project.id} />
          </FadeIn>
          <FadeIn delay={0.25}>
            <ProjectDiscussion projectId={project.id} />
          </FadeIn>
        </div>

        <div className="flex flex-col gap-6">
          <FadeIn delay={0.1}>
            <ProjectTeam project={project} />
          </FadeIn>
        </div>
      </div>
    </div>
  );
}
