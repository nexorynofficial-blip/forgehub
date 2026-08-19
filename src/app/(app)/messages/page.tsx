import type { Metadata } from "next";

import { MessagesEmptyState } from "@/components/messages/messages-empty-state";

export const metadata: Metadata = { title: "Messages" };

export default function MessagesPage() {
  return <MessagesEmptyState />;
}
