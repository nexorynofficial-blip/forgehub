"use client";

import { useQuery } from "@tanstack/react-query";

import { getFollowerPreviews } from "@/lib/services/profile-service";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AvatarStackDialog } from "@/components/shared/avatar-stack-dialog";

/** UI_UX.md §8 "Followers" — avatar stack + count, expands to a preview
 * list. See docs/ASSUMPTIONS.md for why every profile shares one preview
 * pool in this demo. */
export function FollowersWidget({ followersCount }: { followersCount: number }) {
  const { data: followers, isLoading } = useQuery({
    queryKey: ["followerPreviews"],
    queryFn: getFollowerPreviews,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Followers</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading || !followers ? (
          <Skeleton className="h-10 w-40" />
        ) : (
          <AvatarStackDialog
            people={followers}
            totalCount={followersCount}
            label="followers"
            dialogTitle="Followers"
          />
        )}
      </CardContent>
    </Card>
  );
}
