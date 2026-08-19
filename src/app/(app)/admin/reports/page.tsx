import type { Metadata } from "next";

import { ReportsPage } from "@/components/admin/reports-page";

export const metadata: Metadata = { title: "Reports" };

export default function AdminReportsPage() {
  return (
    <div>
      <h1 className="font-display text-2xl font-semibold tracking-tight">Reports</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Review flagged content and take action.
      </p>
      <div className="mt-6">
        <ReportsPage />
      </div>
    </div>
  );
}
