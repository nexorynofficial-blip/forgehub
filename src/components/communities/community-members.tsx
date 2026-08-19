"use client";

import { useQuery } from "@tanstack/react-query";

import { getCommunityMemberPreviews } from "@/lib/services/community-service";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AvatarStackDialog } from "@/components/shared/avatar-stack-dialog";

export function CommunityMembers({ memberCount }: { memberCount: number }) {
  const { data: members, isLoading } = useQuery({
    queryKey: ["communityMemberPreviews"],
    queryFn: getCommunityMemberPreviews,
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
