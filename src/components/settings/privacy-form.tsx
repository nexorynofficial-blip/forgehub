"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { apiErrorMessage } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import {
  getBlockedUsers,
  getPrivacySettings,
  unblockUser,
  updatePrivacySettings,
} from "@/lib/services/settings-service";
import { useToast } from "@/hooks/use-toast";
import type { MessagePermission, PrivacySettings, ProfileVisibility } from "@/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

function ToggleRow({
  label,
  description,
  checked,
  onCheckedChange,
  disabled = false,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {description && <p className="text-muted-foreground text-xs">{description}</p>}
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-label={label}
      />
    </div>
  );
}

/** PRD.md §4.6 has no dedicated "Privacy" feature list — fields here are a
 * reasonable set for a social platform (visibility, contact, 2FA toggle)
 * rather than a literal spec mapping. See docs/ASSUMPTIONS.md (Phase 10). */
export function PrivacyForm() {
  const toast = useToast((state) => state.toast);
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: queryKeys.userSettings,
    queryFn: getPrivacySettings,
  });
  const { data: blockedUsers, isLoading: isLoadingBlocked } = useQuery({
    queryKey: queryKeys.blockedUsers,
    queryFn: getBlockedUsers,
  });

  async function handleUpdate(patch: Partial<PrivacySettings>) {
    try {
      await updatePrivacySettings(patch);
      void queryClient.invalidateQueries({ queryKey: queryKeys.userSettings });
      toast({ title: "Privacy settings updated" });
    } catch (error) {
      toast({
        variant: "danger",
        title: "Could not save that setting",
        description: apiErrorMessage(error, "Please try again in a moment."),
      });
    }
  }

  /**
   * Unblocking is addressed by **username** — `DELETE /users/{username}/block`.
   * The old mock took an id, which had nowhere to go; every blocked record
   * already carries the handle, so that is what is passed.
   */
  async function handleUnblock(username: string, name: string) {
    try {
      await unblockUser(username);
      void queryClient.invalidateQueries({ queryKey: queryKeys.blockedUsers });
      toast({ title: "Unblocked", description: `${name} can interact with you again.` });
    } catch (error) {
      toast({
        variant: "danger",
        title: "Could not unblock",
        description: apiErrorMessage(error, "Please try again in a moment."),
      });
    }
  }

  if (isLoading || !settings) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-72" />
        <Skeleton className="h-32" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Visibility &amp; access</CardTitle>
          <CardDescription>
            Who can see your profile and reach out to you.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-border divide-y">
          <div className="flex items-center justify-between gap-4 py-3">
            <div>
              <p className="text-sm font-medium">Profile visibility</p>
              <p className="text-muted-foreground text-xs">Who can view your profile.</p>
            </div>
            <Select
              value={settings.profileVisibility}
              onValueChange={(value) =>
                handleUpdate({ profileVisibility: value as ProfileVisibility })
              }
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="public">Everyone</SelectItem>
                <SelectItem value="followers">Followers only</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <ToggleRow
            label="Show email on profile"
            checked={settings.showEmailOnProfile}
            onCheckedChange={(checked) => handleUpdate({ showEmailOnProfile: checked })}
          />

          <div className="flex items-center justify-between gap-4 py-3">
            <p className="text-sm font-medium">Who can message you</p>
            <Select
              value={settings.whoCanMessage}
              onValueChange={(value) =>
                handleUpdate({ whoCanMessage: value as MessagePermission })
              }
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="everyone">Everyone</SelectItem>
                <SelectItem value="followers">Followers only</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/*
            Read-only on purpose. The backend refuses `twoFactorEnabled` on this
            endpoint — turning 2FA on means proving you hold the authenticator
            via `/auth/2fa/setup` + `/auth/2fa/confirm`, and turning it off
            needs your password. Neither has an enrolment screen yet, so the row
            reports the real state rather than offering a switch that would fail.
          */}
          <ToggleRow
            label="Two-factor authentication"
            description="Enrolment isn't available in the web app yet."
            checked={settings.twoFactorEnabled}
            disabled
            onCheckedChange={() => undefined}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Blocked users</CardTitle>
          <CardDescription>
            People you&apos;ve blocked can&apos;t message you or see your activity.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoadingBlocked || !blockedUsers ? (
            <Skeleton className="h-10" />
          ) : blockedUsers.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              You haven&apos;t blocked anyone.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {blockedUsers.map((user) => (
                <li key={user.id} className="flex items-center gap-3">
                  <Avatar className="size-9">
                    <AvatarImage src={user.avatarUrl ?? undefined} alt="" />
                    <AvatarFallback>{user.displayName.charAt(0)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{user.displayName}</p>
                    <p className="text-muted-foreground truncate text-xs">
                      @{user.username}
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void handleUnblock(user.username, user.displayName)}
                  >
                    Unblock
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
