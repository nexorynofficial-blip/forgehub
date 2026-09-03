import type { Metadata } from "next";

import { CommunityView } from "@/components/communities/community-view";

interface CommunityPageProps {
  params: Promise<{ communityId: string }>;
}

/**
 * The `[communityId]` segment carries a `Community.slug`, not an id — every
 * backend community route is addressed by slug. The folder name is legacy and
 * the value is correct; renaming it would break existing links for no gain.
 *
 * The title is the slug rather than the community's name: resolving the name
 * server-side would be an anonymous request, which for a private community
 * would 404 anyway. `CommunityView` fetches as the real viewer.
 */
export async function generateMetadata({
  params,
}: CommunityPageProps): Promise<Metadata> {
  const { communityId } = await params;
  return { title: communityId };
}

export default async function CommunityPage({ params }: CommunityPageProps) {
  const { communityId } = await params;
  return <CommunityView slug={communityId} />;
}
