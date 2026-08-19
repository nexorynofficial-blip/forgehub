"use client";

import { useQuery } from "@tanstack/react-query";

import { getProjectMembers } from "@/lib/services/project-service";
import type { Project, ProjectMemberRole } from "@/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AuthorHoverCard } from "@/components/feed/author-hover-card";

const ROLE_LABEL: Record<ProjectMemberRole, string> = {
  owner: "Owner",
  collaborator: "Collaborator",
  contributor: "Contributor",
};

/** UI_UX.md §9 "Team" (PRD.md §4.3 Team Members). */
export function ProjectTeam({ project }: { project: Project }) {
  const { data: members, isLoading } = useQuery({
    queryKey: ["projectMembers", project.id],
    queryFn: () => getProjectMembers(project),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Team</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading || !members ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="size-9 shrink-0 rounded-full" />
                <Skeleton className="h-4 flex-1" />
              </div>
            ))}
          </div>
        ) : (
          <ul className="flex flex-col gap-1">
            {members.map((member) => (
              <li key={member.userId}>
                <AuthorHoverCard author={member.user}>
                  <div className="hover:bg-muted flex items-center gap-3 rounded-md p-1.5 transition-colors">
                    <Avatar>
                      <AvatarImage src={member.user.avatarUrl ?? undefined} alt="" />
                      <AvatarFallback>{member.user.displayName.charAt(0)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {member.user.displayName}
                      </p>
                      <p className="text-muted-foreground truncate text-xs">
                        @{member.user.username}
                      </p>
                    </div>
                    <Badge variant="outline" className="shrink-0">
                      {ROLE_LABEL[member.role]}
                    </Badge>
                  </div>
                </AuthorHoverCard>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
