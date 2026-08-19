"use client";

import { motion } from "framer-motion";

import type { PostAuthor } from "@/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

/** PRD.md §4.7 "Typing Indicators" — see docs/ASSUMPTIONS.md (Phase 09)
 * for how this is simulated without a real socket connection. */
export function TypingIndicator({ person }: { person: PostAuthor }) {
  return (
    <div className="flex items-center gap-2 px-1">
      <Avatar className="size-6">
        <AvatarImage src={person.avatarUrl ?? undefined} alt="" />
        <AvatarFallback className="text-[10px]">
          {person.displayName.charAt(0)}
        </AvatarFallback>
      </Avatar>
      <div className="bg-surface flex items-center gap-1 rounded-full px-3 py-2.5">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="bg-muted-foreground size-1.5 rounded-full"
            animate={{ y: [0, -3, 0] }}
            transition={{ duration: 0.8, repeat: Infinity, delay: i * 0.15 }}
          />
        ))}
      </div>
    </div>
  );
}
