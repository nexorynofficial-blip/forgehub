"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";

import { isAdminRole } from "@/lib/rbac";
import { routes } from "@/lib/routes";
import { getCurrentUser } from "@/lib/services/user-service";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/** TRD.md §7 RBAC, enforced at the route level — not just the sidebar's nav
 * visibility (Phase 04). Purely client-side, like every other guard in this
 * mock build (no session/auth backend exists to enforce it server-side).
 * See docs/ASSUMPTIONS.md (Phase 11). */
export function AdminGuard({ children }: { children: React.ReactNode }) {
  const { data: user, isLoading } = useQuery({
    queryKey: ["currentUser"],
    queryFn: getCurrentUser,
  });

  if (isLoading || !user) {
    return (
      <div className="flex flex-col gap-6 pt-8 pb-8">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (!isAdminRole(user.role)) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 pt-8 text-center">
        <span className="bg-danger/15 text-danger flex size-14 items-center justify-center rounded-full">
          <ShieldAlert className="size-6" />
        </span>
        <p className="font-display text-lg font-semibold">Access denied</p>
        <p className="text-muted-foreground max-w-sm text-sm">
          You need admin or moderator permissions to view this page.
        </p>
        <Button asChild className="mt-2">
          <Link href={routes.dashboard}>Back to dashboard</Link>
        </Button>
      </div>
    );
  }

  return <>{children}</>;
}
