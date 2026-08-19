"use client";

import { useQuery } from "@tanstack/react-query";

import { getAdminUsers } from "@/lib/services/admin-service";
import { Skeleton } from "@/components/ui/skeleton";
import { UsersList } from "@/components/admin/users-list";

export function UsersPage() {
  const { data: users, isLoading } = useQuery({
    queryKey: ["adminUsers"],
    queryFn: getAdminUsers,
  });

  if (isLoading || !users) {
    return (
      <div className="flex flex-col gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
    );
  }

  return <UsersList initialUsers={users} />;
}
