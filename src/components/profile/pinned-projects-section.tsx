"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Eye, Heart } from "lucide-react";

import { formatCompactNumber } from "@/lib/format";
import { PROJECT_STATUS_META } from "@/lib/project-meta";
import { queryKeys } from "@/lib/query-keys";
import { routes } from "@/lib/routes";
import { getTopProjects } from "@/lib/services/project-service";
import type { Project } from "@/types";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

function ProjectCard({ project }: { project: Project }) {
  const status = PROJECT_STATUS_META[project.status];

  return (
    <Link href={routes.project(project.slug)}>
      <motion.div
        whileHover={{ y: -4 }}
        transition={{ type: "spring", stiffness: 400, damping: 25 }}
        className="h-full"
      >
        <Card className="hover:border-border-strong flex h-full flex-col p-5 transition-[border-color,box-shadow] hover:shadow-[var(--shadow-floating)]">
          <div className="flex items-start justify-between gap-2">
            <p className="font-display text-base font-semibold tracking-tight">
              {project.title}
            </p>
            <Badge variant={status.variant} className="shrink-0">
              {status.label}
            </Badge>
          </div>
          <p className="text-muted-foreground mt-1.5 line-clamp-2 flex-1 text-sm">
            {project.description}
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {project.techStack.slice(0, 3).map((tech) => (
              <Badge key={tech} variant="outline" className="text-[10px]">
                {tech}
              </Badge>
            ))}
          </div>
          <div className="border-border mt-4 flex items-center gap-4 border-t pt-3 text-xs">
            <span className="text-muted-foreground flex items-center gap-1">
              <Eye className="size-3.5" />
              {formatCompactNumber(project.metrics.views)}
            </span>
            <span className="text-muted-foreground flex items-center gap-1">
              <Heart className="size-3.5" />
              {formatCompactNumber(project.metrics.likes)}
            </span>
            <span className="text-muted-foreground ml-auto">
              {project.progressPercent}% complete
            </span>
          </div>
        </Card>
      </motion.div>
    </Link>
  );
}

/**
 * UI_UX.md §8 "Pinned Projects", renamed to what it actually is.
 *
 * **There is no pin state to read.** No backend route stores one, and the
 * shipped mock never did either — it sorted by likes and documented that. The
 * list is now the owner's most-liked projects from the real API, so the card
 * is titled "Top projects": keeping the old title would assert a curation the
 * user never performed and cannot change.
 */
export function PinnedProjectsSection({ username }: { username: string }) {
  const { data: projects, isLoading } = useQuery({
    queryKey: queryKeys.ownerProjects(username),
    queryFn: () => getTopProjects(username),
  });

  if (!isLoading && projects?.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Top projects</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 sm:grid-cols-2">
          {isLoading || !projects
            ? Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-40" />
              ))
            : projects.map((project) => (
                <ProjectCard key={project.id} project={project} />
              ))}
        </div>
      </CardContent>
    </Card>
  );
}
