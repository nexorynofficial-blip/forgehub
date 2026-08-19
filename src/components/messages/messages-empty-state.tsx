import { MessageSquare } from "lucide-react";

import { Card } from "@/components/ui/card";

export function MessagesEmptyState() {
  return (
    <Card className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <span className="bg-primary/15 text-primary flex size-14 items-center justify-center rounded-full">
        <MessageSquare className="size-6" />
      </span>
      <div>
        <h1 className="font-display text-lg font-semibold">Select a conversation</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Choose someone from the list to start chatting.
        </p>
      </div>
    </Card>
  );
}
