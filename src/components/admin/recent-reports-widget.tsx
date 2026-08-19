"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { formatRelativeTime } from "@/lib/format";
import { routes } from "@/lib/routes";
import { getReports } from "@/lib/services/admin-service";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function RecentReportsWidget() {
  const { data: reports, isLoading } = useQuery({
    queryKey: ["adminReports", "pending"],
    queryFn: () => getReports("pending"),
  });

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Pending reports</CardTitle>
        <Link
          href={routes.admin.reports}
          className="text-primary focus-visible:ring-ring rounded-sm text-xs font-medium focus-visible:ring-2 focus-visible:outline-none"
        >
          View all
        </Link>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {isLoading || !reports ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 p-2">
              <Skeleton className="size-9 shrink-0 rounded-full" />
              <Skeleton className="h-4 flex-1" />
            </div>
          ))
        ) : reports.length === 0 ? (
          <p className="text-muted-foreground p-2 text-sm">No pending reports.</p>
        ) : (
          reports.slice(0, 4).map((report) => (
            <div key={report.id} className="flex items-center gap-3 p-2">
              <Avatar className="size-9 shrink-0">
                <AvatarImage src={report.reporter.avatarUrl ?? undefined} alt="" />
                <AvatarFallback>{report.reporter.displayName.charAt(0)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">
                  <span className="font-medium">{report.reporter.displayName}</span>{" "}
                  <span className="text-muted-foreground">
                    reported a {report.targetType}
                  </span>
                </p>
                <p className="text-muted-foreground truncate text-xs">
                  {report.targetSummary}
                </p>
              </div>
              <Badge variant="outline" className="shrink-0 text-[10px]">
                {formatRelativeTime(report.createdAt)}
              </Badge>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
