import { formatRelativeTime } from "@/lib/format";
import type { AdminUserSummary, ModerationStatus, UserRole } from "@/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ROLE_OPTIONS: UserRole[] = [
  "guest",
  "member",
  "verified_builder",
  "moderator",
  "community_admin",
  "platform_admin",
];

const ROLE_LABEL: Record<UserRole, string> = {
  guest: "Guest",
  member: "Member",
  verified_builder: "Verified Builder",
  moderator: "Moderator",
  community_admin: "Community Admin",
  platform_admin: "Platform Admin",
};

const STATUS_META: Record<
  ModerationStatus,
  { label: string; variant: BadgeProps["variant"] }
> = {
  active: { label: "Active", variant: "success" },
  banned: { label: "Banned", variant: "danger" },
  shadow_banned: { label: "Shadow banned", variant: "outline" },
};

export function UserRow({
  entry,
  onRoleChange,
  onStatusChange,
}: {
  entry: AdminUserSummary;
  onRoleChange: (userId: string, role: UserRole) => void;
  onStatusChange: (userId: string, status: ModerationStatus) => void;
}) {
  const status = STATUS_META[entry.status];

  return (
    <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 items-center gap-3 sm:flex-1">
        <Avatar>
          <AvatarImage src={entry.user.avatarUrl ?? undefined} alt="" />
          <AvatarFallback>{entry.user.displayName.charAt(0)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{entry.user.displayName}</p>
          <p className="text-muted-foreground truncate text-xs">
            @{entry.user.username} · Joined {formatRelativeTime(entry.joinedAt)}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={entry.role}
          onValueChange={(value) => onRoleChange(entry.user.id, value as UserRole)}
        >
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLE_OPTIONS.map((role) => (
              <SelectItem key={role} value={role}>
                {ROLE_LABEL[role]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Badge variant={status.variant}>{status.label}</Badge>

        {entry.status === "active" ? (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onStatusChange(entry.user.id, "shadow_banned")}
            >
              Shadow ban
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => onStatusChange(entry.user.id, "banned")}
            >
              Ban
            </Button>
          </>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onStatusChange(entry.user.id, "active")}
          >
            Restore
          </Button>
        )}
      </div>
    </Card>
  );
}
