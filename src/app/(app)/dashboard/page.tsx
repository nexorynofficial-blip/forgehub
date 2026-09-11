import type { Metadata } from "next";

import { FadeIn } from "@/components/motion/fade-in";
import { CommunitiesWidget } from "@/components/dashboard/communities-widget";
import { FeedPreviewWidget } from "@/components/dashboard/feed-preview-widget";
import { QuickMessagesWidget } from "@/components/dashboard/quick-messages-widget";
import { StatsGrid } from "@/components/dashboard/stats-grid";
import { TrendingProjectsWidget } from "@/components/dashboard/trending-projects-widget";
import { WelcomeHeader } from "@/components/dashboard/welcome-header";
import { YourProjectsWidget } from "@/components/dashboard/your-projects-widget";

export const metadata: Metadata = { title: "Dashboard" };

/**
 * The signed-in home screen.
 *
 * Every card here is backed by an endpoint that returns real rows. That is the
 * change: three of the six widgets this page used to carry — live activity,
 * the leaderboard, and upcoming events — had no backend route behind them and
 * rendered "not available yet" in the three most valuable cells on the screen.
 * They were right to refuse to fabricate data, but the result was a page that
 * looked unfinished because half of it was empty.
 *
 * The replacements answer the same questions from routes that exist: your own
 * work in progress, what the feed has been doing, and where to find people.
 * Each widget documents the endpoint it maps to.
 *
 * Reading order runs most-personal first: your numbers, your projects, then
 * the wider platform down the right rail.
 */
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
            <YourProjectsWidget />
          </FadeIn>
          <FadeIn delay={0.15}>
            <FeedPreviewWidget />
          </FadeIn>
        </div>

        <div className="flex flex-col gap-6">
          <FadeIn delay={0.1}>
            <TrendingProjectsWidget />
          </FadeIn>
          <FadeIn delay={0.15}>
            <QuickMessagesWidget />
          </FadeIn>
          <FadeIn delay={0.2}>
            <CommunitiesWidget />
          </FadeIn>
        </div>
      </div>
    </div>
  );
}
