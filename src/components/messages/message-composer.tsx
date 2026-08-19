"use client";

import { useState, type FormEvent } from "react";
import { Loader2, Paperclip, Send, X } from "lucide-react";

import type { MessageAttachment } from "@/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmojiPicker } from "@/components/messages/emoji-picker";

/** PRD.md §4.7 "Image Sharing" / "File Upload" — no real upload exists, so
 * attaching just adds a placeholder chip demonstrating the affordance and
 * the resulting bubble rendering. See docs/ASSUMPTIONS.md (Phase 09). */
export function MessageComposer({
  onSend,
}: {
  onSend: (content: string, attachments: MessageAttachment[]) => Promise<void>;
}) {
  const [content, setContent] = useState("");
  const [pendingAttachment, setPendingAttachment] = useState<MessageAttachment | null>(
    null,
  );
  const [isSending, setIsSending] = useState(false);

  function handleAttach() {
    setPendingAttachment({
      id: crypto.randomUUID(),
      url: "#",
      type: "file",
      name: "document.pdf",
    });
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = content.trim();
    if (!trimmed && !pendingAttachment) return;

    setIsSending(true);
    await onSend(trimmed, pendingAttachment ? [pendingAttachment] : []);
    setContent("");
    setPendingAttachment(null);
    setIsSending(false);
  }

  return (
    <form onSubmit={handleSubmit} className="border-border shrink-0 border-t p-3">
      {pendingAttachment && (
        <div className="mb-2 inline-flex">
          <Badge variant="outline" className="gap-1.5 py-1 pr-1">
            <span>{pendingAttachment.name}</span>
            <button
              type="button"
              onClick={() => setPendingAttachment(null)}
              aria-label="Remove attachment"
              className="hover:bg-muted rounded-full p-0.5"
            >
              <X className="size-3" />
            </button>
          </Badge>
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={handleAttach}
          aria-label="Attach file"
        >
          <Paperclip />
        </Button>
        <EmojiPicker onSelect={(emoji) => setContent((prev) => prev + emoji)} />
        <Input
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder="Message…"
          aria-label="Message"
          disabled={isSending}
          className="flex-1"
        />
        <Button
          type="submit"
          size="icon"
          disabled={isSending || (!content.trim() && !pendingAttachment)}
          aria-label="Send message"
        >
          {isSending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Send className="size-4" />
          )}
        </Button>
      </div>
    </form>
  );
}
