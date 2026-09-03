"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { notFound } from "next/navigation";

import { queryKeys } from "@/lib/query-keys";
import { getProjectBySlug, recordProjectView } from "@/lib/services/project-service";
import { Skeleton } from "@/components/ui/skeleton";
import { FadeIn } from "@/components/motion/fade-in";
import { ProjectDiscussion } from "@/components/project/project-discussion";
import { ProjectGallery } from "@/components/project/project-gallery";
import { ProjectHero } from "@/components/project/project-hero";
import { ProjectMetricsBar } from "@/components/project/project-metrics-bar";
import { ProjectRoadmap } from "@/components/project/project-roadmap";
import { ProjectTeam } from "@/components/project/project-team";
import { ProjectUpdates } from "@/components/project/project-updates";

/**
 * The project page's data layer.
 *
 * Client-side for the same reason `ProfileView` is: the access token lives
 * only in browser memory, so a server render would evaluate every project as
 * anonymous — hiding private and unlisted projects from the people who own
 * them, and losing the `viewer` state the Like/Follow buttons need.
 */
export function ProjectView({ slug }: { slug: string }) {
  const { data, isPending, isError } = useQuery({
    queryKey: queryKeys.project(slug),
    queryFn: () => getProjectBySlug(slug),
  });

  const projectId = data?.project.id;

  /**
   * A view is recorded once the project actually resolved, and its outcome is
   * deliberately ignored: the backend de-duplicates per viewer and answers
   * `{ counted: false }` when nothing moved, so there is nothing for the UI to
   * do with the result. A failure here must never break the page — this is
   * telemetry, not content.
   */
  useEffect(() => {
    if (!projectId) return;
    void recordProjectView(slug).catch(() => undefined);
  }, [projectId, slug]);

  if (isPending) return <ProjectSkeleton />;

  // `getProjectBySlug` maps 404 to null. A private project answers 404 rather
  // than 403, so "missing" and "not for you" stay indistinguishable here too.
  if (isError || !data) notFound();

  const { project, viewer } = data;

  return (
    <div className="flex flex-col gap-6 pt-8 pb-8">
      <FadeIn>
        <ProjectHero project={project} viewer={viewer} />
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
            <ProjectUpdates slug={project.slug} />
          </FadeIn>
          <FadeIn delay={0.25}>
            <ProjectDiscussion />
          </FadeIn>
        </div>

        <div className="flex flex-col gap-6">
          <FadeIn delay={0.1}>
            <ProjectTeam slug={project.slug} />
          </FadeIn>
        </div>
      </div>
    </div>
  );
}

function ProjectSkeleton() {
  return (
    <div className="flex flex-col gap-6 pt-8 pb-8">
      <Skeleton className="h-48 w-full rounded-lg sm:h-64" />
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-4 w-full max-w-2xl" />
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
        <Skeleton className="h-48 w-full" />
      </div>
    </div>
  );
}
