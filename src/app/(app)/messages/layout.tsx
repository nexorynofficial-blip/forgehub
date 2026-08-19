import { MessagesShell } from "@/components/messages/messages-shell";

export default function MessagesLayout({ children }: { children: React.ReactNode }) {
  return <MessagesShell>{children}</MessagesShell>;
}
