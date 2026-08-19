import type { Metadata } from "next";

import { UsersPage } from "@/components/admin/users-page";

export const metadata: Metadata = { title: "User Management" };

export default function AdminUsersPage() {
  return (
    <div>
      <h1 className="font-display text-2xl font-semibold tracking-tight">Users</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Manage roles and moderation status.
      </p>
      <div className="mt-6">
        <UsersPage />
      </div>
    </div>
  );
}
