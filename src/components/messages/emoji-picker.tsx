"use client";

import { Smile } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const EMOJIS = [
  "😀",
  "😂",
  "😍",
  "😎",
  "🙌",
  "👍",
  "🎉",
  "🔥",
  "🚀",
  "💯",
  "🙏",
  "👀",
  "✅",
  "❤️",
  "😅",
  "🤔",
  "👏",
  "🎯",
  "💡",
  "😢",
  "😮",
  "🥳",
  "🤝",
  "👋",
];

/** PRD.md §4.7 "Emoji". */
export function EmojiPicker({ onSelect }: { onSelect: (emoji: string) => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="icon" aria-label="Add emoji">
          <Smile />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64" align="start">
        <div className="grid grid-cols-6 gap-1">
          {EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => onSelect(emoji)}
              aria-label={`Insert ${emoji}`}
              className="hover:bg-muted focus-visible:ring-ring flex size-9 items-center justify-center rounded-md text-lg transition-colors focus-visible:ring-2 focus-visible:outline-none"
            >
              {emoji}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
