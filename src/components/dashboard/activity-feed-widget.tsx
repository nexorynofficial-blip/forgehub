import { LiveActivityFeed } from "@/components/marketing/live-activity-feed";

/** UI_UX.md §7 "Feed" — reuses the landing page's Live Activity Feed
 * (same data, same component) sized to fill the dashboard grid cell. */
export function ActivityFeedWidget() {
  return <LiveActivityFeed className="max-w-none" />;
}
