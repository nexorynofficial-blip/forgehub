"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";

import { updateUserRole, updateUserStatus } from "@/lib/services/admin-service";
import { useToast } from "@/hooks/use-toast";
import type { AdminUserSummary, ModerationStatus, UserRole } from "@/types";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { UserRow } from "@/components/admin/user-row";

/** PRD.md §4.12 "User Management". Local optimistic state seeded once from
 * the query, per docs/ARCHITECTURE.md §15. */
export function UsersList({ initialUsers }: { initialUsers: AdminUserSummary[] }) {
  const toast = useToast((state) => state.toast);
  const [users, setUsers] = useState(initialUsers);
  const [search, setSearch] = useState("");

  function handleRoleChange(userId: string, role: UserRole) {
    setUsers((prev) =>
      prev.map((entry) => (entry.user.id === userId ? { ...entry, role } : entry)),
    );
    updateUserRole(userId, role);
    toast({ title: "Role updated" });
  }

  function handleStatusChange(userId: string, status: ModerationStatus) {
    setUsers((prev) =>
      prev.map((entry) => (entry.user.id === userId ? { ...entry, status } : entry)),
    );
    updateUserStatus(userId, status);
    const entry = users.find((u) => u.user.id === userId);
    const label =
      status === "active" ? "restored" : status === "banned" ? "banned" : "shadow banned";
    toast({
      title: `User ${label}`,
      description: entry ? entry.user.displayName : undefined,
      variant: status === "banned" ? "danger" : "default",
    });
  }

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return users;
    return users.filter(
      (entry) =>
        entry.user.displayName.toLowerCase().includes(query) ||
        entry.user.username.toLowerCase().includes(query),
    );
  }, [users, search]);

  return (
    <div className="flex flex-col gap-4">
      <div className="relative max-w-sm">
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
              onRoleChange={handleRoleChange}
              onStatusChange={handleStatusChange}
            />
          ))}
        </div>
      )}
    </div>
  );
}
