"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  AtSign,
  Bell,
  CornerDownRight,
  Heart,
  Mail,
  MessageCircle,
  MessageSquare,
  Rocket,
  ShieldAlert,
  Trophy,
  UserPlus,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { formatRelativeTime } from "@/lib/format";
import { queryKeys } from "@/lib/query-keys";
import {
  getNotifications,
  getUnreadNotificationCount,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationItem,
} from "@/lib/services/notification-service";
import { cn } from "@/lib/utils";
import type { NotificationType } from "@/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * All twelve persisted types.
 *
 * The four beyond the original eight — `reply`, `project_invite`,
 * `community_invite`, `moderation` — are types the server really sends, and a
 * partial map would render an undefined component for them.
 */
const TYPE_ICON: Record<NotificationType, LucideIcon> = {
  like: Heart,
  comment: MessageCircle,
  reply: CornerDownRight,
  mention: AtSign,
  follower: UserPlus,
  project_update: Rocket,
  invite: Mail,
  project_invite: Mail,
  community_invite: Users,
  message: MessageSquare,
  achievement: Trophy,
  moderation: ShieldAlert,
};

function NotificationRow({
  notification,
  onRead,
}: {
  notification: NotificationItem;
  onRead: (id: string) => void;
}) {
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
        <button
          type="button"
          onClick={() => onRead(notification.id)}
          aria-label="Mark as read"
          className="mt-1.5 shrink-0"
        >
          <span className="bg-primary block size-2 rounded-full" aria-hidden="true" />
        </button>
      )}
    </li>
  );
}

/**
 * UI_UX.md §7 — topbar bell with unread badge and dropdown feed.
 *
 * The badge count is its own query rather than a count of loaded rows: unread
 * notifications can sit far beyond the first page, so counting what happens to
 * be in memory would under-report. `SocketProvider` prepends `notification:new`
 * into this list's cache and invalidates the badge, so nothing here polls.
 */
export function NotificationsPanel() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useInfiniteQuery({
    queryKey: queryKeys.notifications,
    queryFn: ({ pageParam }) => getNotifications({ cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const { data: unreadCount = 0 } = useQuery({
    queryKey: queryKeys.unreadNotifications,
    queryFn: getUnreadNotificationCount,
  });

  const readOne = useMutation({
    mutationFn: markNotificationRead,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
      void queryClient.invalidateQueries({ queryKey: queryKeys.unreadNotifications });
    },
  });

  const readAll = useMutation({
    mutationFn: markAllNotificationsRead,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
      void queryClient.invalidateQueries({ queryKey: queryKeys.unreadNotifications });
    },
  });

  if (isLoading) {
    return <Skeleton className="size-10 rounded-full" />;
  }

  const notifications = data?.pages.flatMap((page) => page.items) ?? [];

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
              disabled={readAll.isPending}
              onClick={() => readAll.mutate()}
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
                <NotificationRow
                  key={notification.id}
                  notification={notification}
                  onRead={(id) => readOne.mutate(id)}
                />
              ))}
            </ul>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
