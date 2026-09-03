"use client";

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";

import { apiErrorMessage } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { updateUserRole, updateUserStatus } from "@/lib/services/admin-service";
import { useToast } from "@/hooks/use-toast";
import type { AdminUserSummary, ModerationStatus, UserRole } from "@/types";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { UserRow } from "@/components/admin/user-row";

/**
 * PRD.md §4.12 "User Management".
 *
 * Role and status changes go to the server and the table is invalidated
 * afterwards, so a rejected change reverts rather than lingering as a UI-only
 * edit. A role change in particular is `platform_admin`-only and will 403 for
 * an ordinary admin — which must be visible, not silently swallowed.
 *
 * The search filters the loaded page. The endpoint offers `role` and `status`
 * filters but no text search, and inventing one is not this phase's job; the
 * page size is stated so the scope of the filter is honest.
 */
export function UsersList({
  users,
  total,
}: {
  users: AdminUserSummary[];
  total: number;
}) {
  const toast = useToast((state) => state.toast);
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers });
  }

  function reportError(error: unknown) {
    toast({
      variant: "danger",
      title: "That change did not go through",
      description: apiErrorMessage(error, "Please try again in a moment."),
    });
  }

  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: UserRole }) =>
      updateUserRole(userId, role),
    onSuccess: () => {
      invalidate();
      toast({ title: "Role updated" });
    },
    onError: reportError,
  });

  const changeStatus = useMutation({
    mutationFn: ({ userId, status }: { userId: string; status: ModerationStatus }) =>
      updateUserStatus(userId, status),
    onSuccess: (_result, { userId, status }) => {
      invalidate();
      const entry = users.find((u) => u.user.id === userId);
      const label =
        status === "active"
          ? "restored"
          : status === "banned"
            ? "banned"
            : "shadow banned";
      toast({
        title: `User ${label}`,
        description: entry?.user.displayName,
        variant: status === "banned" ? "danger" : "default",
      });
    },
    onError: reportError,
  });

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return users;
    return users.filter(
      (entry) =>
        entry.user.displayName.toLowerCase().includes(query) ||
        entry.user.username.toLowerCase().includes(query),
    );
  }, [users, search]);

  const isBusy = changeRole.isPending || changeStatus.isPending;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2" />
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name or username…"
            aria-label="Search users"
            className="pl-10"
          />
        </div>
        <p className="text-muted-foreground text-xs">
          Showing {users.length} of {total}
        </p>
      </div>

      {filtered.length === 0 ? (
        <Card className="p-10 text-center">
          <p className="text-muted-foreground text-sm">No users match your search.</p>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map((entry) => (
            <UserRow
              key={entry.user.id}
              entry={entry}
              disabled={isBusy}
              onRoleChange={(userId, role) => changeRole.mutate({ userId, role })}
              onStatusChange={(userId, status) => changeStatus.mutate({ userId, status })}
            />
          ))}
        </div>
      )}
    </div>
  );
}
