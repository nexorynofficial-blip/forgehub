"use client";

import { useQuery } from "@tanstack/react-query";

import { apiErrorMessage } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { getAdminUsers } from "@/lib/services/admin-service";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { UsersList } from "@/components/admin/users-list";

/** PRD.md §4.12 "User Management" — offset-paginated, server-authorized. */
export function UsersPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.adminUsers,
    queryFn: () => getAdminUsers({ limit: 50 }),
  });

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <Card className="p-10 text-center">
        <p className="text-muted-foreground text-sm">
          {apiErrorMessage(error, "The user list could not be loaded.")}
        </p>
      </Card>
    );
  }

  return <UsersList users={data?.items ?? []} total={data?.pagination.total ?? 0} />;
}
