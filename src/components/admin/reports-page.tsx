"use client";

import { useQuery } from "@tanstack/react-query";

import { getReports } from "@/lib/services/admin-service";
import { Skeleton } from "@/components/ui/skeleton";
import { ReportsList } from "@/components/admin/reports-list";

export function ReportsPage() {
  const { data: reports, isLoading } = useQuery({
    queryKey: ["adminReports"],
    queryFn: () => getReports(),
  });

  if (isLoading || !reports) {
    return (
      <div className="flex flex-col gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-40" />
        ))}
      </div>
    );
  }

  return <ReportsList initialReports={reports} />;
}
