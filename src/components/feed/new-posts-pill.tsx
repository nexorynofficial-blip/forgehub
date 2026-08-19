"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ArrowUp } from "lucide-react";

/** UI_UX.md §10 "Auto Refresh". */
export function NewPostsPill({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <AnimatePresence>
      {count > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          className="sticky top-20 z-10 flex justify-center"
        >
          <button
            type="button"
            onClick={onClick}
            className="bg-primary text-primary-foreground focus-visible:ring-ring flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium shadow-[var(--shadow-glow-primary)] focus-visible:ring-2 focus-visible:outline-none"
          >
            <ArrowUp className="size-3.5" />
            {count} new post{count === 1 ? "" : "s"}
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
