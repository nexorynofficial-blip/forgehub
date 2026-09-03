"use client";

import { motion } from "framer-motion";

/**
 * PRD.md §4.7 "Typing Indicators" — now driven by the real
 * `message:typing` / `message:stop_typing` socket events.
 *
 * Takes usernames rather than a resolved `PostAuthor`: the server's typing
 * relay carries `{ conversationId, userId, username }` and nothing else, and
 * resolving an avatar per frame would mean a request per keystroke.
 */
export function TypingIndicator({ usernames }: { usernames: string[] }) {
  if (usernames.length === 0) return null;

  const label =
    usernames.length === 1
      ? `${usernames[0]} is typing`
      : usernames.length === 2
        ? `${usernames[0]} and ${usernames[1]} are typing`
        : "Several people are typing";

  return (
    <div className="flex items-center gap-2 px-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      <div className="bg-surface flex items-center gap-1 rounded-full px-2.5 py-2">
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
