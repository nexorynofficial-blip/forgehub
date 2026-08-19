import type { Metadata } from "next";

import { FadeIn } from "@/components/motion/fade-in";
import { OverviewStats } from "@/components/admin/overview-stats";
import { ReportsByReasonChart } from "@/components/admin/reports-by-reason-chart";
import { WeeklySignupsChart } from "@/components/admin/weekly-signups-chart";

export const metadata: Metadata = { title: "Analytics" };

export default function AdminAnalyticsPage() {
  return (
    <div className="flex flex-col gap-6">
      <FadeIn>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Analytics</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Platform growth and moderation trends.
        </p>
      </FadeIn>

      <FadeIn delay={0.05}>
        <OverviewStats />
      </FadeIn>

      <div className="grid gap-6 lg:grid-cols-2">
        <FadeIn delay={0.1}>
          <WeeklySignupsChart />
        </FadeIn>
        <FadeIn delay={0.1}>
          <ReportsByReasonChart />
        </FadeIn>
      </div>
    </div>
  );
}
