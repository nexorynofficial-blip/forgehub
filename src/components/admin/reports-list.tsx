"use client";

import { useState } from "react";

import { updateReportStatus, updateUserStatus } from "@/lib/services/admin-service";
import { useToast } from "@/hooks/use-toast";
import type { ReportStatus, ReportWithDetails } from "@/types";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ReportRow } from "@/components/admin/report-row";

const FILTERS: { value: "all" | ReportStatus; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "resolved", label: "Resolved" },
  { value: "dismissed", label: "Dismissed" },
];

/** PRD.md §4.12 "Moderation Queue" / "Flagged Posts" / "Content Removal" /
 * "Ban Users" / "Shadow Ban" — one connected workflow. Local optimistic
 * state seeded once from the query, per docs/ARCHITECTURE.md §15. */
export function ReportsList({ initialReports }: { initialReports: ReportWithDetails[] }) {
  const toast = useToast((state) => state.toast);
  const [reports, setReports] = useState(initialReports);
  const [filter, setFilter] = useState<"all" | ReportStatus>("all");

  function updateStatus(id: string, status: ReportStatus) {
    setReports((prev) =>
      prev.map((report) => (report.id === id ? { ...report, status } : report)),
    );
    updateReportStatus(id, status);
  }

  function handleDismiss(id: string) {
    updateStatus(id, "dismissed");
    toast({ title: "Report dismissed" });
  }

  function handleResolve(id: string) {
    updateStatus(id, "resolved");
    toast({ title: "Report resolved" });
  }

  function handleBanUser(report: ReportWithDetails) {
    if (!report.targetAuthorId) return;
    updateUserStatus(report.targetAuthorId, "banned");
    updateStatus(report.id, "resolved");
    toast({
      title: "User banned",
      description: `${report.targetAuthor?.displayName} can no longer access ForgeHub.`,
      variant: "danger",
    });
  }

  function handleShadowBanUser(report: ReportWithDetails) {
    if (!report.targetAuthorId) return;
    updateUserStatus(report.targetAuthorId, "shadow_banned");
    updateStatus(report.id, "resolved");
    toast({
      title: "User shadow banned",
      description: `${report.targetAuthor?.displayName}'s content is now hidden from others.`,
    });
  }

  const filtered =
    filter === "all" ? reports : reports.filter((report) => report.status === filter);

  return (
    <div className="flex flex-col gap-4">
      <Tabs value={filter} onValueChange={(value) => setFilter(value as typeof filter)}>
        <TabsList>
          {FILTERS.map((item) => (
            <TabsTrigger key={item.value} value={item.value}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {filtered.length === 0 ? (
        <Card className="p-10 text-center">
          <p className="text-muted-foreground text-sm">No reports here.</p>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map((report) => (
            <ReportRow
              key={report.id}
              report={report}
              onDismiss={handleDismiss}
              onResolve={handleResolve}
              onBanUser={handleBanUser}
              onShadowBanUser={handleShadowBanUser}
            />
          ))}
        </div>
      )}
    </div>
  );
}
