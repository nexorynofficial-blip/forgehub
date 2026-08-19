import type { Metadata } from "next";

import { FadeIn } from "@/components/motion/fade-in";
import { CommunityDiscovery } from "@/components/communities/community-discovery";

export const metadata: Metadata = { title: "Communities" };

export default function CommunitiesPage() {
  return (
    <div className="pt-8 pb-8">
      <FadeIn>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Communities
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Find your people — by stack, by stage, or by what you&apos;re building.
        </p>
      </FadeIn>
      <FadeIn delay={0.05} className="mt-6">
        <CommunityDiscovery />
      </FadeIn>
    </div>
  );
}
