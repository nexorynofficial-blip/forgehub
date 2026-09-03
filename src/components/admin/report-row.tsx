import { AtSign, FileText, FolderGit2, MessageCircle, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { formatRelativeTime } from "@/lib/format";
import type { ModerationReport } from "@/lib/services/admin-service";
import type { ReportReason, ReportStatus, ReportTargetType } from "@/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

const TARGET_ICON: Record<ReportTargetType, LucideIcon> = {
  post: FileText,
  comment: MessageCircle,
  project: FolderGit2,
  community: Users,
  user: AtSign,
};

const TARGET_LABEL: Record<ReportTargetType, string> = {
  post: "Post",
  comment: "Comment",
  project: "Project",
  community: "Community",
  user: "User",
};

const REASON_LABEL: Record<ReportReason, string> = {
  spam: "Spam",
  harassment: "Harassment",
  inappropriate_content: "Inappropriate content",
  impersonation: "Impersonation",
  other: "Other",
};

const STATUS_META: Record<
  ReportStatus,
  { label: string; variant: BadgeProps["variant"] }
> = {
  pending: { label: "Pending", variant: "primary" },
  resolved: { label: "Resolved", variant: "success" },
  dismissed: { label: "Dismissed", variant: "outline" },
};

export function ReportRow({
  report,
  disabled = false,
  onDismiss,
  onResolve,
  onBanUser,
  onShadowBanUser,
}: {
  report: ModerationReport;
  disabled?: boolean;
  onDismiss: (id: string) => void;
  onResolve: (id: string) => void;
  onBanUser: (report: ModerationReport) => void;
  onShadowBanUser: (report: ModerationReport) => void;
}) {
  const TargetIcon = TARGET_ICON[report.targetType];
  const status = STATUS_META[report.status];
  const isPending = report.status === "pending";
  // Nullable: a report whose reporter has since been deleted still belongs in
  // the queue, and the row must not crash on it.
  const reporterName = report.reporter?.displayName ?? "A deleted account";

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <Avatar className="size-9 shrink-0">
          <AvatarImage src={report.reporter?.avatarUrl ?? undefined} alt="" />
          <AvatarFallback>{reporterName.charAt(0)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm">
              <span className="font-medium">{reporterName}</span>{" "}
              <span className="text-muted-foreground">reported a</span>{" "}
              <span className="font-medium">{report.targetType}</span>
            </p>
            <Badge variant="outline" className="text-[10px]">
              {REASON_LABEL[report.reason]}
            </Badge>
            <Badge variant={status.variant} className="ml-auto">
              {status.label}
            </Badge>
          </div>

          {/*
            The reported content is identified, not quoted.

            The API deliberately serves no summary of the target: building one
            would mean projecting the text of a private project or a direct
            message into a moderation response. Staff open the target itself to
            read it, so this row states what kind of thing was reported and who
            owns it.
          */}
          <div className="bg-surface mt-2 flex items-start gap-2 rounded-md p-3">
            <TargetIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm">{TARGET_LABEL[report.targetType]} reported</p>
              {report.targetAuthor && (
                <p className="text-muted-foreground mt-1 text-xs">
                  by {report.targetAuthor.displayName} (@{report.targetAuthor.username})
                </p>
              )}
            </div>
          </div>

          {report.details && (
            <p className="text-muted-foreground mt-2 text-sm">{report.details}</p>
          )}
          <time className="text-muted-foreground text-xs">
            {formatRelativeTime(report.createdAt)}
          </time>

          {isPending && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={disabled}
                onClick={() => onDismiss(report.id)}
              >
                Dismiss
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={disabled}
                onClick={() => onResolve(report.id)}
              >
                Resolve
              </Button>
              {report.targetAuthor && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    onClick={() => onShadowBanUser(report)}
                  >
                    Shadow ban author
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={disabled}
                    onClick={() => onBanUser(report)}
                  >
                    Ban author
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
