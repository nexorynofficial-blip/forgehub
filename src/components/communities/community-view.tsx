"use client";

import { useQuery } from "@tanstack/react-query";
import { notFound } from "next/navigation";

import { queryKeys } from "@/lib/query-keys";
import { getCommunityBySlug } from "@/lib/services/community-service";
import { Skeleton } from "@/components/ui/skeleton";
import { FadeIn } from "@/components/motion/fade-in";
import { CommunityEvents } from "@/components/communities/community-events";
import { CommunityHero } from "@/components/communities/community-hero";
import { CommunityMembers } from "@/components/communities/community-members";
import { CommunityPinnedPosts } from "@/components/communities/community-pinned-posts";
import { CommunityRules } from "@/components/communities/community-rules";

/**
 * The community page's data layer.
 *
 * Client-side for the same reason the profile and project pages are: the
 * access token is memory-only, so a server render would evaluate every
 * community as anonymous — hiding private communities from their own members
 * and losing the `viewer` state the Join button depends on.
 */
export function CommunityView({ slug }: { slug: string }) {
  const { data, isPending, isError } = useQuery({
    queryKey: queryKeys.community(slug),
    queryFn: () => getCommunityBySlug(slug),
  });

  if (isPending) return <CommunitySkeleton />;

  // A private community answers 404 rather than 403, so "missing" and
  // "not for you" are deliberately the same outcome here.
  if (isError || !data) notFound();

  const { community, viewer } = data;

  return (
    <div className="flex flex-col gap-6 pt-8 pb-8">
      <FadeIn>
        <CommunityHero community={community} viewer={viewer} />
      </FadeIn>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <FadeIn delay={0.1}>
            <CommunityPinnedPosts slug={community.slug} />
          </FadeIn>
        </div>

        <div className="flex flex-col gap-6">
          <FadeIn delay={0.05}>
            <CommunityMembers slug={community.slug} memberCount={community.memberCount} />
          </FadeIn>
          <FadeIn delay={0.1}>
            <CommunityEvents events={community.events} />
          </FadeIn>
          <FadeIn delay={0.15}>
            <CommunityRules rules={community.rules} />
          </FadeIn>
        </div>
      </div>
    </div>
  );
}

function CommunitySkeleton() {
  return (
    <div className="flex flex-col gap-6 pt-8 pb-8">
      <Skeleton className="h-40 w-full rounded-lg sm:h-56" />
      <div className="flex flex-col gap-3 px-2 sm:px-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-full max-w-2xl" />
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Skeleton className="h-64 w-full lg:col-span-2" />
        <div className="flex flex-col gap-6">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    </div>
  );
}
