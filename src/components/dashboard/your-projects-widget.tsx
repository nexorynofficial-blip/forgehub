"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Plus } from "lucide-react";

import { PROJECT_STATUS_META } from "@/lib/project-meta";
import { queryKeys } from "@/lib/query-keys";
import { routes } from "@/lib/routes";
import { getProjectsByOwner } from "@/lib/services/project-service";
import { getCurrentUser } from "@/lib/services/user-service";
import { cn } from "@/lib/utils";
import type { ProjectDetail } from "@/lib/services/project-service";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The signed-in user's own projects, with how far along each one is.
 *
 * This is the dashboard's centre of gravity, and it replaces the leaderboard —
 * which could only ever render empty, because no ranking endpoint exists
 * anywhere in the backend (`dashboard-service.ts` says so and refuses to
 * invent one).
 *
 * `progressPercent` is a real column the owner sets themselves, so the bar
 * measures something rather than decorating a row. It is the one place on the
 * dashboard where ForgeHub's actual subject — work in progress, in public — is
 * visible as a shape rather than a number.
 */

function ProjectRow({ project }: { project: ProjectDetail }) {
  const status = PROJECT_STATUS_META[project.status];
  const percent = Math.max(0, Math.min(100, project.progressPercent));

  return (
    <Link
      href={routes.project(project.slug)}
      className="hover:bg-muted focus-visible:ring-ring group flex flex-col gap-2.5 rounded-md p-3 transition-colors focus-visible:ring-2 focus-visible:outline-none"
    >
      <div className="flex items-center gap-3">
        <p className="group-hover:text-primary min-w-0 flex-1 truncate text-sm font-medium transition-colors">
          {project.title}
        </p>
        <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
          {status.label}
        </Badge>
      </div>

      <div className="flex items-center gap-3">
        {/* The track is the muted surface rather than a tinted one, so the
            filled portion is the only thing carrying colour. */}
        <div className="bg-muted h-1.5 flex-1 overflow-hidden rounded-full">
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-500",
              percent === 100 ? "bg-success" : "bg-primary",
            )}
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className="text-muted-foreground w-9 shrink-0 text-right text-xs tabular-nums">
          {percent}%
        </span>
      </div>
    </Link>
  );
}

export function YourProjectsWidget() {
  const { data: user } = useQuery({
    queryKey: queryKeys.currentUser,
    queryFn: getCurrentUser,
  });

  const username = user?.username;

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.ownerProjects(username ?? ""),
    queryFn: () => getProjectsByOwner(username as string, { limit: 4, sort: "updated" }),
    enabled: Boolean(username),
  });

  const projects = data?.items ?? [];
  const pending = isLoading || !username;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Your projects</CardTitle>
        {projects.length > 0 && (
          <Button asChild variant="ghost" size="sm">
            <Link href={routes.newProject}>
              <Plus className="size-4" />
              New
            </Link>
          </Button>
        )}
      </CardHeader>

      <CardContent className="flex flex-col gap-1">
        {pending ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-2.5 p-3">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-1.5 w-full rounded-full" />
            </div>
          ))
        ) : projects.length === 0 ? (
          /* An empty screen is an invitation to act, not an apology. */
          <div className="flex flex-col items-start gap-3 p-3">
            <p className="text-muted-foreground text-sm">
              Nothing here yet. A title is all you need to start — the roadmap,
              milestones, and team can follow.
            </p>
            <Button asChild variant="primary" size="sm">
              <Link href={routes.newProject}>
                Create your first project
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </div>
        ) : (
          projects.map((project) => <ProjectRow key={project.id} project={project} />)
        )}
      </CardContent>
    </Card>
  );
}
