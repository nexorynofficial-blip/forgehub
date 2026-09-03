"use client";

import { useQuery } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import { Lock } from "lucide-react";

import { queryKeys } from "@/lib/query-keys";
import { getProfile } from "@/lib/services/profile-service";
import { isRestrictedProfile } from "@/types";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { FadeIn } from "@/components/motion/fade-in";
import { AchievementsSection } from "@/components/profile/achievements-section";
import { ContributionHeatmap } from "@/components/profile/contribution-heatmap";
import { FollowersWidget } from "@/components/profile/followers-widget";
import { PinnedProjectsSection } from "@/components/profile/pinned-projects-section";
import { ProfileBanner } from "@/components/profile/profile-banner";
import { ProfileTimeline } from "@/components/profile/profile-timeline";

/**
 * The profile page's data layer.
 *
 * This is a client component, and that is a consequence of the auth design
 * rather than a preference: the access token lives only in browser memory, so
 * a server render has no way to identify the viewer. Fetching on the server
 * would evaluate every profile as anonymous — collapsing followers-only
 * profiles for everyone and losing the follow state the header needs. The
 * markup below is exactly what the server component rendered before.
 */
export function ProfileView({ username }: { username: string }) {
  const { data, isPending, isError } = useQuery({
    queryKey: queryKeys.profile(username),
    queryFn: () => getProfile(username),
  });

  if (isPending) return <ProfileSkeleton />;

  // `getProfile` maps 404 to null. The backend answers 404 — never 403 — for a
  // profile that exists but is hidden from this viewer, so "missing" and
  // "not for you" are deliberately the same outcome here too.
  if (isError || !data) notFound();

  const { user, relationship } = data;
  const restricted = isRestrictedProfile(user);

  return (
    <div className="flex flex-col gap-6 pt-8 pb-8">
      <FadeIn>
        <ProfileBanner user={user} relationship={relationship} />
      </FadeIn>

      {restricted ? (
        <FadeIn delay={0.05}>
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
              <span className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
                <Lock className="size-5" />
              </span>
              <p className="font-medium">This profile is followers-only</p>
              <p className="text-muted-foreground max-w-sm text-sm">
                Follow @{user.username} to see their activity, projects, and achievements.
              </p>
            </CardContent>
          </Card>
        </FadeIn>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="flex flex-col gap-6 lg:col-span-2">
            <FadeIn delay={0.05}>
              <ContributionHeatmap username={user.username} />
            </FadeIn>
            <FadeIn delay={0.1}>
              <PinnedProjectsSection username={user.username} />
            </FadeIn>
            <FadeIn delay={0.15}>
              <ProfileTimeline username={user.username} />
            </FadeIn>
          </div>

          <div className="flex flex-col gap-6">
            <FadeIn delay={0.05}>
              <FollowersWidget
                username={user.username}
                followersCount={user.followersCount}
              />
            </FadeIn>
            <FadeIn delay={0.1}>
              <AchievementsSection achievements={user.achievements} />
            </FadeIn>
          </div>
        </div>
      )}
    </div>
  );
}

function ProfileSkeleton() {
  return (
    <div className="flex flex-col gap-6 pt-8 pb-8">
      <Skeleton className="h-40 w-full rounded-lg sm:h-56" />
      <div className="flex flex-col gap-3 px-2 sm:px-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-full max-w-2xl" />
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
        <div className="flex flex-col gap-6">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    </div>
  );
}
