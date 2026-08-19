"use client";

import { useQuery } from "@tanstack/react-query";
import { Flame } from "lucide-react";

import { getCurrentUser } from "@/lib/services/user-service";
import { Skeleton } from "@/components/ui/skeleton";

function greetingForHour(hour: number): string {
  if (hour < 5) return "Still building";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function WelcomeHeader() {
  const { data: user, isLoading } = useQuery({
    queryKey: ["currentUser"],
    queryFn: getCurrentUser,
  });

  if (isLoading || !user) {
    return (
      <div>
        <Skeleton className="h-8 w-64" />
        <Skeleton className="mt-3 h-4 w-48" />
      </div>
    );
  }

  const firstName = user.displayName.split(" ")[0];

  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
          {greetingForHour(new Date().getHours())}, {firstName}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Here&apos;s what&apos;s happening across ForgeHub.
        </p>
      </div>
      <div className="border-border-strong bg-card flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium">
        <Flame className="text-accent size-4" />
        {user.dailyStreak}-day streak
      </div>
    </div>
  );
}
