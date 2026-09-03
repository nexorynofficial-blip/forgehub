"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { formatRelativeTime } from "@/lib/format";
import { routes } from "@/lib/routes";
import { queryKeys } from "@/lib/query-keys";
import { getRecentlyJoinedUsers } from "@/lib/services/admin-service";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function RecentUsersWidget() {
  const { data: users, isLoading } = useQuery({
    queryKey: [...queryKeys.adminUsers, "recent"],
    queryFn: () => getRecentlyJoinedUsers(),
  });

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Recently joined</CardTitle>
        <Link
          href={routes.admin.users}
          className="text-primary focus-visible:ring-ring rounded-sm text-xs font-medium focus-visible:ring-2 focus-visible:outline-none"
        >
          View all
        </Link>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {isLoading || !users
          ? Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 p-2">
                <Skeleton className="size-9 shrink-0 rounded-full" />
                <Skeleton className="h-4 flex-1" />
              </div>
            ))
          : users.map((entry) => (
              <div key={entry.user.id} className="flex items-center gap-3 p-2">
                <Avatar className="size-9">
                  <AvatarImage src={entry.user.avatarUrl ?? undefined} alt="" />
                  <AvatarFallback>{entry.user.displayName.charAt(0)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{entry.user.displayName}</p>
                  <p className="text-muted-foreground truncate text-xs">
                    @{entry.user.username}
                  </p>
                </div>
                <span className="text-muted-foreground shrink-0 text-xs">
                  {formatRelativeTime(entry.joinedAt)}
                </span>
              </div>
            ))}
      </CardContent>
    </Card>
  );
}
