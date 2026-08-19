"use client";

import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  getNotificationPreferences,
  updateNotificationPreference,
} from "@/lib/services/settings-service";
import type { NotificationPreferences, NotificationType } from "@/types";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

const TYPE_LABEL: Record<NotificationType, string> = {
  like: "Likes",
  comment: "Comments",
  mention: "Mentions",
  follower: "New followers",
  project_update: "Project updates",
  invite: "Collaboration invites",
  message: "Messages",
  achievement: "Achievements",
};

const TYPES = Object.keys(TYPE_LABEL) as NotificationType[];

function NotificationsMatrix({
  initialPreferences,
}: {
  initialPreferences: NotificationPreferences;
}) {
  const [preferences, setPreferences] = useState(initialPreferences);

  function handleToggle(
    type: NotificationType,
    channel: "inApp" | "email",
    value: boolean,
  ) {
    setPreferences((prev) => ({ ...prev, [type]: { ...prev[type], [channel]: value } }));
    updateNotificationPreference(type, channel, value);
  }

  return (
    <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-6">
      <span className="text-muted-foreground pb-2 text-xs font-medium">Type</span>
      <span className="text-muted-foreground pb-2 text-xs font-medium">In-app</span>
      <span className="text-muted-foreground pb-2 text-xs font-medium">Email</span>
      {TYPES.map((type) => (
        <Fragment key={type}>
          <span className="border-border border-t py-3 text-sm">{TYPE_LABEL[type]}</span>
          <span className="border-border flex justify-center border-t py-3">
            <Switch
              checked={preferences[type].inApp}
              onCheckedChange={(checked) => handleToggle(type, "inApp", checked)}
              aria-label={`${TYPE_LABEL[type]} in-app notifications`}
            />
          </span>
          <span className="border-border flex justify-center border-t py-3">
            <Switch
              checked={preferences[type].email}
              onCheckedChange={(checked) => handleToggle(type, "email", checked)}
              aria-label={`${TYPE_LABEL[type]} email notifications`}
            />
          </span>
        </Fragment>
      ))}
    </div>
  );
}

/** PRD.md §4.8 Notifications — one row per type, in-app/email columns.
 * `NotificationsMatrix` only mounts once the query resolves, so its local
 * `useState(initialPreferences)` is correct on first render — no
 * effect-based sync needed. Toggles are local optimistic state from then
 * on (same pattern as `PostCard`'s like button and `ProfileBanner`'s
 * follow toggle) rather than round-tripping through the query cache per
 * click — see docs/ASSUMPTIONS.md (Phase 10). */
export function NotificationsForm() {
  const { data: preferences, isLoading } = useQuery({
    queryKey: ["notificationPreferences"],
    queryFn: getNotificationPreferences,
  });

  return (
    <Card>
      <CardContent className="pt-6">
        {isLoading || !preferences ? (
          <Skeleton className="h-72" />
        ) : (
          <NotificationsMatrix initialPreferences={preferences} />
        )}
      </CardContent>
    </Card>
  );
}
