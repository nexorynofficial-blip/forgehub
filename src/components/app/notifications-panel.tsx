"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  AtSign,
  Bell,
  Heart,
  Mail,
  MessageCircle,
  MessageSquare,
  Rocket,
  Trophy,
  UserPlus,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { formatRelativeTime } from "@/lib/format";
import {
  getNotifications,
  markAllNotificationsRead,
} from "@/lib/services/notification-service";
import { cn } from "@/lib/utils";
import type { NotificationType, NotificationWithActor } from "@/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";

const TYPE_ICON: Record<NotificationType, LucideIcon> = {
  like: Heart,
  comment: MessageCircle,
  mention: AtSign,
  follower: UserPlus,
  project_update: Rocket,
  invite: Mail,
  message: MessageSquare,
  achievement: Trophy,
};

function NotificationRow({ notification }: { notification: NotificationWithActor }) {
  const Icon = TYPE_ICON[notification.type];

  return (
    <li
      className={cn(
        "flex items-start gap-3 px-4 py-3",
        !notification.isRead && "bg-primary/5",
      )}
    >
      {notification.actorName ? (
        <Avatar className="size-9">
          <AvatarImage src={notification.actorAvatarUrl ?? undefined} alt="" />
          <AvatarFallback>{notification.actorName.charAt(0)}</AvatarFallback>
        </Avatar>
      ) : (
        <span className="bg-primary/15 text-primary flex size-9 shrink-0 items-center justify-center rounded-full">
          <Icon className="size-4" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-foreground text-sm leading-snug">{notification.message}</p>
        <time className="text-muted-foreground text-xs">
          {formatRelativeTime(notification.createdAt)}
        </time>
      </div>
      {!notification.isRead && (
        <span
          className="bg-primary mt-1.5 size-2 shrink-0 rounded-full"
          aria-hidden="true"
        />
      )}
    </li>
  );
}

/** Bell trigger + list, only mounted once the query resolves — same
 * local-optimistic-state pattern as `NotificationsMatrix`
 * (components/settings/notifications-form.tsx). See docs/ASSUMPTIONS.md
 * (Phase 10) for why this list avoids relying on `invalidateQueries` to
 * re-render itself. */
function NotificationsBell({
  initialNotifications,
}: {
  initialNotifications: NotificationWithActor[];
}) {
  const [notifications, setNotifications] = useState(initialNotifications);
  const unreadCount = notifications.filter((n) => !n.isRead).length;

  async function handleMarkAllRead() {
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
    await markAllNotificationsRead();
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={
            unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"
          }
        >
          <motion.span
            className="inline-flex"
            animate={unreadCount > 0 ? { rotate: [0, -14, 12, -8, 4, 0] } : { rotate: 0 }}
            transition={{ duration: 0.6, ease: "easeInOut" }}
          >
            <Bell />
          </motion.span>
          {unreadCount > 0 && (
            <motion.span
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", stiffness: 500, damping: 15 }}
              className="bg-danger border-surface absolute top-1.5 right-1.5 size-2.5 rounded-full border-2"
              aria-hidden="true"
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={12} className="w-80 p-0">
        <div className="flex items-center justify-between px-4 py-3">
          <p className="font-display text-sm font-semibold">Notifications</p>
          {unreadCount > 0 && (
            <Button
              variant="link"
              size="sm"
              className="text-xs"
              onClick={handleMarkAllRead}
            >
              Mark all read
            </Button>
          )}
        </div>
        <div className="bg-border h-px" />
        <ScrollArea className="max-h-96">
          {notifications.length === 0 ? (
            <p className="text-muted-foreground p-6 text-center text-sm">
              You&apos;re all caught up.
            </p>
          ) : (
            <ul className="divide-border divide-y">
              {notifications.map((notification) => (
                <NotificationRow key={notification.id} notification={notification} />
              ))}
            </ul>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

/** UI_UX.md §7 "Notifications" — topbar bell with unread badge and dropdown feed. */
export function NotificationsPanel() {
  const { data: notifications, isLoading } = useQuery({
    queryKey: ["notifications"],
    queryFn: getNotifications,
  });

  if (isLoading || !notifications) {
    return <Skeleton className="size-10 rounded-full" />;
  }

  return <NotificationsBell initialNotifications={notifications} />;
}
