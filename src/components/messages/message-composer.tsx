"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Loader2, Paperclip, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmojiPicker } from "@/components/messages/emoji-picker";

/** How long after the last keystroke a "stop typing" frame is sent. */
const TYPING_IDLE_MS = 2_000;

/**
 * PRD.md §4.7 composer.
 *
 * Two changes from the shipped version, both about not faking things:
 *
 *  - **Attachments are disabled.** There is no upload endpoint anywhere in the
 *    backend, so the old handler minted a chip with `url: "#"` that then
 *    rendered as a successfully sent file. The button stays — it is part of
 *    the layout — but says plainly that it is not available.
 *  - **Typing frames are real.** `onTyping` relays over the socket, throttled
 *    to one frame per idle window rather than one per keystroke.
 */
export function MessageComposer({
  onSend,
  onTyping,
}: {
  onSend: (content: string) => Promise<void>;
  onTyping?: (typing: boolean) => void;
}) {
  const [content, setContent] = useState("");
  const [isSending, setIsSending] = useState(false);

  const isTyping = useRef(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // A composer that unmounts mid-sentence must not leave the other side
  // watching a typing indicator that never stops.
  useEffect(() => {
    return () => {
      clearTimeout(idleTimer.current);
      if (isTyping.current) onTyping?.(false);
    };
  }, [onTyping]);

  function handleChange(value: string) {
    setContent(value);
    if (!onTyping) return;

    if (!isTyping.current) {
      isTyping.current = true;
      onTyping(true);
    }

    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      isTyping.current = false;
      onTyping(false);
    }, TYPING_IDLE_MS);
  }

  function stopTyping() {
    clearTimeout(idleTimer.current);
    if (isTyping.current) {
      isTyping.current = false;
      onTyping?.(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = content.trim();
    if (!trimmed) return;

    setIsSending(true);
    stopTyping();
    try {
      await onSend(trimmed);
      setContent("");
    } finally {
      setIsSending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="border-border shrink-0 border-t p-3">
      <div className="flex items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            {/* A disabled button reports no pointer events, so the span is what
                the tooltip can hang on. */}
            <span className="inline-flex">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled
                aria-label="Attach file (unavailable)"
              >
                <Paperclip />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>File sharing is not available yet</TooltipContent>
        </Tooltip>
        <EmojiPicker onSelect={(emoji) => handleChange(content + emoji)} />
        <Input
          value={content}
          onChange={(event) => handleChange(event.target.value)}
          onBlur={stopTyping}
          placeholder="Message…"
          aria-label="Message"
          disabled={isSending}
          className="flex-1"
        />
        <Button
          type="submit"
          size="icon"
          disabled={isSending || !content.trim()}
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
