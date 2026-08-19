import type { Metadata } from "next";

import { FadeIn } from "@/components/motion/fade-in";
import { ActivityFeedWidget } from "@/components/dashboard/activity-feed-widget";
import { LeaderboardWidget } from "@/components/dashboard/leaderboard-widget";
import { QuickMessagesWidget } from "@/components/dashboard/quick-messages-widget";
import { StatsGrid } from "@/components/dashboard/stats-grid";
import { TrendingProjectsWidget } from "@/components/dashboard/trending-projects-widget";
import { UpcomingEventsWidget } from "@/components/dashboard/upcoming-events-widget";
import { WelcomeHeader } from "@/components/dashboard/welcome-header";

export const metadata: Metadata = { title: "Dashboard" };

export default function DashboardPage() {
  return (
    <div className="flex flex-col gap-8 pt-8">
      <FadeIn>
        <WelcomeHeader />
      </FadeIn>

      <FadeIn delay={0.05}>
        <StatsGrid />
      </FadeIn>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <FadeIn delay={0.1}>
            <ActivityFeedWidget />
          </FadeIn>
          <FadeIn delay={0.15}>
            <TrendingProjectsWidget />
          </FadeIn>
        </div>

        <div className="flex flex-col gap-6">
          <FadeIn delay={0.1}>
            <LeaderboardWidget />
          </FadeIn>
          <FadeIn delay={0.15}>
            <UpcomingEventsWidget />
          </FadeIn>
          <FadeIn delay={0.2}>
            <QuickMessagesWidget />
          </FadeIn>
        </div>
      </div>
    </div>
  );
}
