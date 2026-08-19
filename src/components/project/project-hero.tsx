"use client";

import Image from "next/image";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, ExternalLink } from "lucide-react";

import { PROJECT_FUNDING_META, PROJECT_STATUS_META } from "@/lib/project-meta";
import { getProjectMembers } from "@/lib/services/project-service";
import type { Project } from "@/types";
import { GitHubIcon } from "@/components/auth/oauth-icons";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AuthorHoverCard } from "@/components/feed/author-hover-card";

/** UI_UX.md §9 "Large Cover". Reuses the Phase 05 profile banner's
 * gradient-drift treatment since no real `coverImageUrl` exists in any
 * fixture. */
export function ProjectHero({ project }: { project: Project }) {
  const { data: members } = useQuery({
    queryKey: ["projectMembers", project.id],
    queryFn: () => getProjectMembers(project),
  });
  const owner = members?.find((member) => member.role === "owner");
  const status = PROJECT_STATUS_META[project.status];

  return (
    <div>
      <div className="bg-surface relative h-48 overflow-hidden rounded-lg sm:h-64">
        {project.coverImageUrl ? (
          <Image src={project.coverImageUrl} alt="" fill className="object-cover" />
        ) : (
          <div
            aria-hidden="true"
            className="animate-gradient-shift size-full"
            style={{
              backgroundImage:
                "radial-gradient(circle at 15% 30%, rgb(124 92 255 / 35%), transparent 55%), " +
                "radial-gradient(circle at 85% 20%, rgb(0 212 255 / 25%), transparent 50%), " +
                "radial-gradient(circle at 50% 90%, rgb(255 184 0 / 15%), transparent 45%)",
            }}
          />
        )}
      </div>

      <div className="mt-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
              {project.title}
            </h1>
            <Badge variant={status.variant}>{status.label}</Badge>
            <Badge variant="outline">{PROJECT_FUNDING_META[project.fundingStage]}</Badge>
          </div>

          {owner && (
            <AuthorHoverCard author={owner.user}>
              <span className="text-muted-foreground hover:text-foreground mt-2 inline-flex items-center gap-1.5 text-sm transition-colors">
                <Avatar className="size-5">
                  <AvatarImage src={owner.user.avatarUrl ?? undefined} alt="" />
                  <AvatarFallback className="text-[10px]">
                    {owner.user.displayName.charAt(0)}
                  </AvatarFallback>
                </Avatar>
                {owner.user.displayName}
              </span>
            </AuthorHoverCard>
          )}

          <p className="text-muted-foreground mt-3 max-w-2xl text-sm leading-relaxed">
            {project.description}
          </p>

          <div className="mt-4 flex flex-wrap gap-1.5">
            {project.tags.map((tag) => (
              <Badge key={tag} variant="primary">
                {tag}
              </Badge>
            ))}
            {project.techStack.map((tech) => (
              <Badge key={tech} variant="outline">
                {tech}
              </Badge>
            ))}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          {project.demoUrl && (
            <Button asChild variant="primary">
              <a href={project.demoUrl} target="_blank" rel="noreferrer">
                <ExternalLink />
                Live demo
              </a>
            </Button>
          )}
          {project.repositoryUrl && (
            <Button asChild variant="secondary">
              <a href={project.repositoryUrl} target="_blank" rel="noreferrer">
                <GitHubIcon className="size-4" />
                Repository
              </a>
            </Button>
          )}
          {project.documentationUrl && (
            <Button asChild variant="outline">
              <a href={project.documentationUrl} target="_blank" rel="noreferrer">
                <BookOpen />
                Docs
              </a>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
