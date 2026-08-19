"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Users } from "lucide-react";

import { formatCompactNumber } from "@/lib/format";
import { getCommunityModerators } from "@/lib/services/community-service";
import { useToast } from "@/hooks/use-toast";
import type { Community } from "@/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AuthorHoverCard } from "@/components/feed/author-hover-card";

export function CommunityHero({ community }: { community: Community }) {
  const toast = useToast((state) => state.toast);
  const [isJoined, setIsJoined] = useState(false);
  const { data: moderators } = useQuery({
    queryKey: ["communityModerators", community.id],
    queryFn: () => getCommunityModerators(community),
  });

  function handleJoinToggle() {
    setIsJoined((prev) => !prev);
    toast({
      title: isJoined ? "Left community" : "Joined community",
      description: isJoined
        ? `You left ${community.name}.`
        : `Welcome to ${community.name}!`,
    });
  }

  return (
    <div>
      <div className="bg-surface relative h-40 overflow-hidden rounded-lg sm:h-56">
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
      </div>

      <div className="relative px-2 sm:px-4">
        <Avatar className="border-background bg-card absolute -top-10 left-4 size-20 border-4 sm:-top-12 sm:size-24">
          <AvatarImage src={community.avatarUrl ?? undefined} alt="" />
          <AvatarFallback className="text-2xl">{community.name.charAt(0)}</AvatarFallback>
        </Avatar>

        <div className="flex justify-end pt-4">
          <Button variant={isJoined ? "secondary" : "primary"} onClick={handleJoinToggle}>
            {isJoined ? "Joined" : "Join community"}
          </Button>
        </div>

        <div className="mt-6 sm:mt-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-display text-2xl font-semibold tracking-tight">
              {community.name}
            </h1>
            <Badge variant="primary">{community.category}</Badge>
          </div>
          <p className="text-muted-foreground mt-2 max-w-2xl text-sm leading-relaxed">
            {community.description}
          </p>

          <div className="mt-4 flex flex-wrap gap-1.5">
            {community.tags.map((tag) => (
              <Badge key={tag} variant="outline">
                {tag}
              </Badge>
            ))}
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <span className="flex items-center gap-1.5">
              <Users className="text-muted-foreground size-4" />
              <strong className="font-semibold">
                {formatCompactNumber(community.memberCount)}
              </strong>{" "}
              <span className="text-muted-foreground">members</span>
            </span>
            {moderators && moderators.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Moderated by</span>
                <div className="flex -space-x-2">
                  {moderators.map((moderator) => (
                    <AuthorHoverCard key={moderator.id} author={moderator}>
                      <Avatar className="border-card size-6 border-2">
                        <AvatarImage src={moderator.avatarUrl ?? undefined} alt="" />
                        <AvatarFallback className="text-[10px]">
                          {moderator.displayName.charAt(0)}
                        </AvatarFallback>
                      </Avatar>
                    </AuthorHoverCard>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
