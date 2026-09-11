"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Users } from "lucide-react";

import { formatCompactNumber } from "@/lib/format";
import { routes } from "@/lib/routes";
import { getCommunities } from "@/lib/services/community-service";
import type { CommunitySummary } from "@/lib/services/community-service";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Communities worth joining.
 *
 * Replaces the upcoming-events widget. Events are per-community in this
 * backend (`GET /communities/{slug}/events`) with no global route, so that
 * card could only ever say it was unavailable — while `GET /communities` was
 * sitting there unused. The user's next useful action is joining a room, not
 * being told a calendar does not exist.
 */

const PREVIEW_COUNT = 4;

function CommunityRow({ community }: { community: CommunitySummary }) {
  return (
    <Link
      href={routes.community(community.slug)}
      className="hover:bg-muted focus-visible:ring-ring group flex items-center gap-3 rounded-md p-2.5 transition-colors focus-visible:ring-2 focus-visible:outline-none"
    >
      <Avatar className="size-9 shrink-0 rounded-md">
        <AvatarImage src={community.avatarUrl ?? undefined} alt="" />
        <AvatarFallback className="rounded-md text-xs">
          {community.name.charAt(0)}
        </AvatarFallback>
      </Avatar>

      <div className="min-w-0 flex-1">
        <p className="group-hover:text-primary truncate text-sm font-medium transition-colors">
          {community.name}
        </p>
        <p className="text-muted-foreground flex items-center gap-1 text-xs">
          <Users className="size-3" />
          {formatCompactNumber(community.memberCount)} members
        </p>
      </div>
    </Link>
  );
}

export function CommunitiesWidget() {
  const { data, isLoading } = useQuery({
    queryKey: ["communities", "dashboard-preview"],
    queryFn: () => getCommunities({ limit: PREVIEW_COUNT }),
  });

  const communities = data?.items ?? [];

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Communities</CardTitle>
        <Button asChild variant="ghost" size="sm">
          <Link href={routes.communities}>
            Browse
            <ArrowRight className="size-4" />
          </Link>
        </Button>
      </CardHeader>

      <CardContent className="flex flex-col gap-1">
        {isLoading ? (
          Array.from({ length: PREVIEW_COUNT }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 p-2.5">
              <Skeleton className="size-9 shrink-0 rounded-md" />
              <div className="flex-1">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="mt-1.5 h-3 w-16" />
              </div>
            </div>
          ))
        ) : communities.length === 0 ? (
          <div className="flex flex-col items-start gap-3 p-2.5">
            <p className="text-muted-foreground text-sm">
              No communities yet. Start one and gather the people building what you
              build.
            </p>
            <Button asChild variant="primary" size="sm">
              <Link href={routes.communities}>
                Browse communities
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </div>
        ) : (
          communities.map((community) => (
            <CommunityRow key={community.id} community={community} />
          ))
        )}
      </CardContent>
    </Card>
  );
}
