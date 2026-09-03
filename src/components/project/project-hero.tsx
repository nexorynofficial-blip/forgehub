"use client";

import { useState } from "react";
import Image from "next/image";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BookOpen, ExternalLink, Heart, Star } from "lucide-react";

import { apiErrorMessage } from "@/lib/api";
import { PROJECT_FUNDING_META, PROJECT_STATUS_META } from "@/lib/project-meta";
import { queryKeys } from "@/lib/query-keys";
import {
  followProject,
  likeProject,
  unfollowProject,
  unlikeProject,
  type ProjectDetail,
  type ProjectViewerState,
} from "@/lib/services/project-service";
import { useToast } from "@/hooks/use-toast";
import { GitHubIcon } from "@/components/auth/oauth-icons";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AuthorHoverCard } from "@/components/feed/author-hover-card";

/**
 * UI_UX.md §9 "Large Cover" — unchanged treatment, real data behind it.
 *
 * The owner byline now reads `project.owner`, which the backend embeds in the
 * detail response precisely so this header needs no second request. The old
 * member-list lookup existed only because the mock stored no owner on the
 * project itself.
 */
export function ProjectHero({
  project,
  viewer,
}: {
  project: ProjectDetail;
  viewer: ProjectViewerState | null;
}) {
  const toast = useToast((state) => state.toast);
  const queryClient = useQueryClient();
  const owner = project.owner;
  const status = PROJECT_STATUS_META[project.status];

  // Seeded from the server, then replaced by whatever the server answers next.
  // The mutation never guesses the resulting state; it reports what came back.
  const [liked, setLiked] = useState(viewer?.hasLiked ?? false);
  const [following, setFollowing] = useState(viewer?.isFollowing ?? false);

  const engage = useMutation({
    mutationFn: async (action: "like" | "follow") => {
      if (action === "like") {
        return liked ? unlikeProject(project.slug) : likeProject(project.slug);
      }
      return following ? unfollowProject(project.slug) : followProject(project.slug);
    },
    onSuccess: (result) => {
      if ("liked" in result) setLiked(result.liked);
      else setFollowing(result.following);
      void queryClient.invalidateQueries({ queryKey: queryKeys.project(project.slug) });
    },
    onError: (error) => {
      toast({
        variant: "danger",
        title: "That did not go through",
        description: apiErrorMessage(error, "Please try again in a moment."),
      });
    },
  });

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

          <AuthorHoverCard author={owner}>
            <span className="text-muted-foreground hover:text-foreground mt-2 inline-flex items-center gap-1.5 text-sm transition-colors">
              <Avatar className="size-5">
                <AvatarImage src={owner.avatarUrl ?? undefined} alt="" />
                <AvatarFallback className="text-[10px]">
                  {owner.displayName.charAt(0)}
                </AvatarFallback>
              </Avatar>
              {owner.displayName}
            </span>
          </AuthorHoverCard>

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
          {/* Rendered only for a signed-in viewer. `viewer` is null for
              anonymous callers, and an affordance that can only ever answer
              401 is worse than no affordance. */}
          {viewer && (
            <>
              <Button
                variant={liked ? "primary" : "secondary"}
                disabled={engage.isPending}
                onClick={() => engage.mutate("like")}
                aria-pressed={liked}
              >
                <Heart className={liked ? "fill-current" : undefined} />
                {liked ? "Liked" : "Like"}
              </Button>
              <Button
                variant={following ? "primary" : "secondary"}
                disabled={engage.isPending}
                onClick={() => engage.mutate("follow")}
                aria-pressed={following}
              >
                <Star className={following ? "fill-current" : undefined} />
                {following ? "Following" : "Follow"}
              </Button>
            </>
          )}
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
