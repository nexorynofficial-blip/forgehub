import type { Metadata } from "next";

import { FadeIn } from "@/components/motion/fade-in";
import { OverviewStats } from "@/components/admin/overview-stats";
import { RecentReportsWidget } from "@/components/admin/recent-reports-widget";
import { RecentUsersWidget } from "@/components/admin/recent-users-widget";

export const metadata: Metadata = { title: "Admin" };

export default function AdminOverviewPage() {
  return (
    <div className="flex flex-col gap-6">
      <FadeIn>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Admin</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Platform health, moderation, and growth at a glance.
        </p>
      </FadeIn>

      <FadeIn delay={0.05}>
        <OverviewStats />
      </FadeIn>

      <div className="grid gap-6 lg:grid-cols-2">
        <FadeIn delay={0.1}>
          <RecentReportsWidget />
        </FadeIn>
        <FadeIn delay={0.1}>
          <RecentUsersWidget />
        </FadeIn>
      </div>
    </div>
  );
}
