"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Users } from "lucide-react";

import { apiErrorMessage } from "@/lib/api";
import { formatCompactNumber } from "@/lib/format";
import { queryKeys } from "@/lib/query-keys";
import {
  getCommunityModerators,
  joinCommunity,
  leaveCommunity,
  type CommunityDetail,
  type CommunityViewerState,
} from "@/lib/services/community-service";
import { useToast } from "@/hooks/use-toast";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AuthorHoverCard } from "@/components/feed/author-hover-card";

export function CommunityHero({
  community,
  viewer,
}: {
  community: CommunityDetail;
  viewer: CommunityViewerState | null;
}) {
  const toast = useToast((state) => state.toast);
  const queryClient = useQueryClient();
  const [isJoined, setIsJoined] = useState(viewer?.isMember ?? false);

  const { data: moderators } = useQuery({
    queryKey: queryKeys.communityModerators(community.slug),
    queryFn: () => getCommunityModerators(community.slug),
  });

  const membership = useMutation({
    /**
     * The two endpoints answer with different shapes — join returns the
     * refreshed viewer state, leave returns `{ left }` — so both are
     * normalised here to the one fact this component needs.
     */
    mutationFn: async (join: boolean): Promise<{ isMember: boolean }> => {
      if (join) {
        const viewerState = await joinCommunity(community.slug);
        return { isMember: viewerState.isMember };
      }
      const { left } = await leaveCommunity(community.slug);
      return { isMember: !left };
    },
    onSuccess: (result, join) => {
      setIsJoined(result.isMember);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.community(community.slug),
      });
      toast({
        title: join ? "Joined community" : "Left community",
        description: join
          ? `Welcome to ${community.name}!`
          : `You left ${community.name}.`,
      });
    },
    onError: (error) => {
      toast({
        variant: "danger",
        title: "That did not go through",
        description: apiErrorMessage(error, "Please try again in a moment."),
      });
    },
  });

  /**
   * The button is shown only when the server says this viewer can act.
   *
   * `canJoin` is false for a private community and for someone already inside,
   * so a member sees "Joined" (leave) and a non-member of a private community
   * sees nothing — rather than a button whose only possible outcome is a 403.
   */
  const canAct = viewer !== null && (isJoined || viewer.canJoin);

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

        <div className="flex min-h-9 justify-end pt-4">
          {canAct && (
            <Button
              variant={isJoined ? "secondary" : "primary"}
              disabled={membership.isPending}
              onClick={() => membership.mutate(!isJoined)}
            >
              {isJoined ? "Joined" : "Join community"}
            </Button>
          )}
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
