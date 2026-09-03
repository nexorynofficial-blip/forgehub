"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiErrorMessage } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import {
  updateReportStatus,
  updateUserStatus,
  type ModerationReport,
} from "@/lib/services/admin-service";
import { useToast } from "@/hooks/use-toast";
import type { ModerationStatus, ReportStatus } from "@/types";
import { Card } from "@/components/ui/card";
import { ReportRow } from "@/components/admin/report-row";

/**
 * PRD.md §4.12 "Moderation Queue" — one connected workflow, now writing to the
 * real backend.
 *
 * The list is no longer seeded into local state. Every mutation invalidates
 * the queue instead, so what is on screen is what the server holds: a report
 * whose status change was rejected must not stay flipped in the UI, and the
 * old optimistic-only version had no path back from a failure.
 */
export function ReportsList({
  reports,
  filter,
}: {
  reports: ModerationReport[];
  filter: "all" | ReportStatus;
}) {
  const toast = useToast((state) => state.toast);
  const queryClient = useQueryClient();

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["moderation", "reports"] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.adminStats });
  }

  function reportError(error: unknown) {
    toast({
      variant: "danger",
      title: "That action did not go through",
      description: apiErrorMessage(error, "Please try again in a moment."),
    });
  }

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: ReportStatus }) =>
      updateReportStatus(id, status),
    onSuccess: (_result, { status }) => {
      invalidate();
      toast({ title: status === "resolved" ? "Report resolved" : "Report dismissed" });
    },
    onError: reportError,
  });

  /**
   * Ban / shadow-ban.
   *
   * The status change and the report closure are two server calls and are
   * awaited in order: closing the report first would leave a queue that claims
   * the matter is handled if the ban then failed.
   *
   * The **target state** is what gets sent (`banned` / `shadow_banned`), which
   * is how this UI has always been shaped and what the endpoint accepts. The
   * backend maps it to the right moderation verb and records the action — this
   * component does not re-derive that mapping.
   */
  const moderateUser = useMutation({
    mutationFn: async ({
      report,
      status,
    }: {
      report: ModerationReport;
      status: ModerationStatus;
    }) => {
      if (!report.targetAuthorId) throw new Error("This report has no target author.");
      await updateUserStatus(report.targetAuthorId, status);
      await updateReportStatus(report.id, "resolved");
    },
    onSuccess: (_result, { report, status }) => {
      invalidate();
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers });
      const name = report.targetAuthor?.displayName ?? "That user";
      toast({
        title: status === "banned" ? "User banned" : "User shadow banned",
        description:
          status === "banned"
            ? `${name} can no longer access ForgeHub.`
            : `${name}'s content is now hidden from others.`,
        variant: status === "banned" ? "danger" : "default",
      });
    },
    onError: reportError,
  });

  const isBusy = setStatus.isPending || moderateUser.isPending;

  if (reports.length === 0) {
    return (
      <Card className="p-10 text-center">
        <p className="text-muted-foreground text-sm">
          {filter === "all" ? "No reports yet." : `No ${filter} reports.`}
        </p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {reports.map((report) => (
        <ReportRow
          key={report.id}
          report={report}
          disabled={isBusy}
          onDismiss={(id) => setStatus.mutate({ id, status: "dismissed" })}
          onResolve={(id) => setStatus.mutate({ id, status: "resolved" })}
          onBanUser={(target) =>
            moderateUser.mutate({ report: target, status: "banned" })
          }
          onShadowBanUser={(target) =>
            moderateUser.mutate({ report: target, status: "shadow_banned" })
          }
        />
      ))}
    </div>
  );
}
