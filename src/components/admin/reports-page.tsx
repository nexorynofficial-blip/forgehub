"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { apiErrorMessage } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { getReports } from "@/lib/services/admin-service";
import type { ReportStatus } from "@/types";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ReportsList } from "@/components/admin/reports-list";

const FILTERS: { value: "all" | ReportStatus; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "resolved", label: "Resolved" },
  { value: "dismissed", label: "Dismissed" },
];

/**
 * The moderation queue.
 *
 * The status filter moved from the browser to the server. The mock held every
 * report in one array so filtering locally was complete; the real queue is
 * paginated, and filtering one page would show "no reports here" for a status
 * whose rows simply sit on page two.
 *
 * A 403 is left to surface as an error rather than being pre-empted by a role
 * check: the server is the authority on who may read this queue, and a
 * frontend guard would only ever be a second opinion.
 */
export function ReportsPage() {
  const [filter, setFilter] = useState<"all" | ReportStatus>("all");

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.reports(filter),
    queryFn: () =>
      getReports({ status: filter === "all" ? undefined : filter, limit: 50 }),
  });

  return (
    <div className="flex flex-col gap-4">
      <Tabs value={filter} onValueChange={(value) => setFilter(value as typeof filter)}>
        <TabsList>
          {FILTERS.map((item) => (
            <TabsTrigger key={item.value} value={item.value}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {isLoading ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      ) : error ? (
        <Card className="p-10 text-center">
          <p className="text-muted-foreground text-sm">
            {apiErrorMessage(error, "The moderation queue could not be loaded.")}
          </p>
        </Card>
      ) : (
        <ReportsList reports={data?.items ?? []} filter={filter} />
      )}
    </div>
  );
}
