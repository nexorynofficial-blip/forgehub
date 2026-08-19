"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Heart } from "lucide-react";

import { formatCompactNumber } from "@/lib/format";
import { routes } from "@/lib/routes";
import { getTrendingProjects } from "@/lib/services/dashboard-service";
import type { TrendingProjectSummary } from "@/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

function ProjectRow({ project }: { project: TrendingProjectSummary }) {
  return (
    <Link
      href={routes.project(project.slug)}
      className="hover:bg-muted focus-visible:ring-ring group flex gap-3 rounded-md p-3 transition-colors focus-visible:ring-2 focus-visible:outline-none"
    >
      <div className="bg-muted font-display text-muted-foreground flex size-12 shrink-0 items-center justify-center rounded-md text-sm font-semibold">
        {project.title.charAt(0)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="group-hover:text-primary truncate text-sm font-medium transition-colors">
            {project.title}
          </p>
          <span className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs">
            <Heart className="size-3.5" />
            {formatCompactNumber(project.likesCount)}
          </span>
        </div>
        <p className="text-muted-foreground mt-0.5 truncate text-xs">
          {project.description}
        </p>
        <div className="mt-2 flex items-center gap-2">
          <Avatar className="size-5">
            <AvatarImage src={project.ownerAvatarUrl ?? undefined} alt="" />
            <AvatarFallback className="text-[10px]">
              {project.ownerName.charAt(0)}
            </AvatarFallback>
          </Avatar>
          <span className="text-muted-foreground text-xs">{project.ownerName}</span>
          <div className="ml-auto flex gap-1">
            {project.techStack.slice(0, 2).map((tech) => (
              <Badge key={tech} variant="outline" className="px-1.5 py-0 text-[10px]">
                {tech}
              </Badge>
            ))}
          </div>
        </div>
      </div>
    </Link>
  );
}

/** UI_UX.md §7 "Trending Projects". */
export function TrendingProjectsWidget() {
  const { data: projects, isLoading } = useQuery({
    queryKey: ["trendingProjects"],
    queryFn: getTrendingProjects,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Trending projects</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {isLoading || !projects
          ? Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex gap-3 p-3">
                <Skeleton className="size-12 shrink-0 rounded-md" />
                <div className="flex-1">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="mt-2 h-3 w-full" />
                </div>
              </div>
            ))
          : projects.map((project) => <ProjectRow key={project.id} project={project} />)}
      </CardContent>
    </Card>
  );
}
