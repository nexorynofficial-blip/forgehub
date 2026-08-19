import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getCommunityBySlug } from "@/lib/services/community-service";
import { FadeIn } from "@/components/motion/fade-in";
import { CommunityEvents } from "@/components/communities/community-events";
import { CommunityHero } from "@/components/communities/community-hero";
import { CommunityMembers } from "@/components/communities/community-members";
import { CommunityPinnedPosts } from "@/components/communities/community-pinned-posts";
import { CommunityRules } from "@/components/communities/community-rules";

interface CommunityPageProps {
  params: Promise<{ communityId: string }>;
}

/** The `[communityId]` segment is matched against `Community.slug`, same
 * pattern as `[username]` and `[projectId]` — see docs/ARCHITECTURE.md §12. */
export async function generateMetadata({
  params,
}: CommunityPageProps): Promise<Metadata> {
  const { communityId } = await params;
  const community = await getCommunityBySlug(communityId);
  if (!community) return { title: "Community not found" };
  return { title: community.name };
}

export default async function CommunityPage({ params }: CommunityPageProps) {
  const { communityId } = await params;
  const community = await getCommunityBySlug(communityId);
  if (!community) notFound();

  return (
    <div className="flex flex-col gap-6 pt-8 pb-8">
      <FadeIn>
        <CommunityHero community={community} />
      </FadeIn>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <FadeIn delay={0.1}>
            <CommunityPinnedPosts community={community} />
          </FadeIn>
        </div>

        <div className="flex flex-col gap-6">
          <FadeIn delay={0.05}>
            <CommunityMembers memberCount={community.memberCount} />
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
