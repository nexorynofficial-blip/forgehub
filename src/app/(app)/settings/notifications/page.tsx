import type { Metadata } from "next";

import { NotificationsForm } from "@/components/settings/notifications-form";

export const metadata: Metadata = { title: "Notification settings" };

export default function NotificationsSettingsPage() {
  return (
    <div>
      <h1 className="font-display text-2xl font-semibold tracking-tight">
        Notifications
      </h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Choose how you want to be notified for each type of activity.
      </p>
      <div className="mt-6">
        <NotificationsForm />
      </div>
    </div>
  );
}
