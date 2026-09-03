"use client";

import { useQuery } from "@tanstack/react-query";

import { queryKeys } from "@/lib/query-keys";
import { getFollowerPreviews } from "@/lib/services/profile-service";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AvatarStackDialog } from "@/components/shared/avatar-stack-dialog";

/**
 * UI_UX.md §8 "Followers" — avatar stack + count, expands to a preview list.
 *
 * Now one real, bounded page of *this* profile's followers, rather than the
 * single shared pool the mock served to every profile. The list is
 * cursor-paginated server-side because it can be large, so the widget asks for
 * a preview page; the total beside the stack is the profile's own counter.
 */
export function FollowersWidget({
  username,
  followersCount,
}: {
  username: string;
  followersCount: number;
}) {
  const { data: followers, isLoading } = useQuery({
    queryKey: queryKeys.followers(username),
    queryFn: () => getFollowerPreviews(username),
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
