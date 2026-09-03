"use client";

import { useQuery } from "@tanstack/react-query";

import { queryKeys } from "@/lib/query-keys";
import { getCommunityMemberPreviews } from "@/lib/services/community-service";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AvatarStackDialog } from "@/components/shared/avatar-stack-dialog";

/** The avatar stack now previews *this* community's members. The mock served
 * one shared pool to every community because no membership graph existed. */
export function CommunityMembers({
  slug,
  memberCount,
}: {
  slug: string;
  memberCount: number;
}) {
  const { data: members, isLoading } = useQuery({
    queryKey: queryKeys.communityMembers(slug),
    queryFn: () => getCommunityMemberPreviews(slug),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Members</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading || !members ? (
          <Skeleton className="h-10 w-40" />
        ) : (
          <AvatarStackDialog
            people={members}
            totalCount={memberCount}
            label="members"
            dialogTitle="Members"
          />
        )}
      </CardContent>
    </Card>
  );
}
