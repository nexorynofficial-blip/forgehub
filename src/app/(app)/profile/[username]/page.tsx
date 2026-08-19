import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getUserByUsername } from "@/lib/services/profile-service";
import { FadeIn } from "@/components/motion/fade-in";
import { AchievementsSection } from "@/components/profile/achievements-section";
import { ContributionHeatmap } from "@/components/profile/contribution-heatmap";
import { FollowersWidget } from "@/components/profile/followers-widget";
import { PinnedProjectsSection } from "@/components/profile/pinned-projects-section";
import { ProfileBanner } from "@/components/profile/profile-banner";
import { ProfileTimeline } from "@/components/profile/profile-timeline";

interface ProfilePageProps {
  params: Promise<{ username: string }>;
}

export async function generateMetadata({ params }: ProfilePageProps): Promise<Metadata> {
  const { username } = await params;
  const user = await getUserByUsername(username);
  if (!user) return { title: "Profile not found" };
  return { title: `${user.displayName} (@${user.username})` };
}

export default async function ProfilePage({ params }: ProfilePageProps) {
  const { username } = await params;
  const user = await getUserByUsername(username);
  if (!user) notFound();

  return (
    <div className="flex flex-col gap-6 pt-8 pb-8">
      <FadeIn>
        <ProfileBanner user={user} />
      </FadeIn>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <FadeIn delay={0.05}>
            <ContributionHeatmap username={user.username} />
          </FadeIn>
          <FadeIn delay={0.1}>
            <PinnedProjectsSection ownerId={user.id} />
          </FadeIn>
          <FadeIn delay={0.15}>
            <ProfileTimeline username={user.username} />
          </FadeIn>
        </div>

        <div className="flex flex-col gap-6">
          <FadeIn delay={0.05}>
            <FollowersWidget followersCount={user.followersCount} />
          </FadeIn>
          <FadeIn delay={0.1}>
            <AchievementsSection achievements={user.achievements} />
          </FadeIn>
        </div>
      </div>
    </div>
  );
}
