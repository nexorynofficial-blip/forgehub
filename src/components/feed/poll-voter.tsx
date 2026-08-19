"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Poll } from "@/types";

/** Local optimistic vote — no Poll API exists yet (TRD.md §5), see
 * docs/ASSUMPTIONS.md (Phase 06). */
export function PollVoter({ poll }: { poll: Poll }) {
  const [votedOptionId, setVotedOptionId] = useState<string | null>(null);
  const [options, setOptions] = useState(poll.options);
  const totalVotes = options.reduce((sum, option) => sum + option.voteCount, 0);

  function handleVote(optionId: string) {
    if (votedOptionId) return;
    setVotedOptionId(optionId);
    setOptions((prev) =>
      prev.map((option) =>
        option.id === optionId ? { ...option, voteCount: option.voteCount + 1 } : option,
      ),
    );
  }

  return (
    <div className="mt-3 flex flex-col gap-2">
      <p className="text-sm font-medium">{poll.question}</p>
      {options.map((option) => {
        const percent =
          totalVotes > 0 ? Math.round((option.voteCount / totalVotes) * 100) : 0;
        const isSelected = votedOptionId === option.id;

        return (
          <motion.button
            key={option.id}
            type="button"
            onClick={() => handleVote(option.id)}
            disabled={!!votedOptionId}
            whileTap={!votedOptionId ? { scale: 0.98 } : undefined}
            className={cn(
              "border-border-strong focus-visible:ring-ring relative overflow-hidden rounded-md border px-3 py-2 text-left text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none",
              !votedOptionId && "hover:border-primary",
            )}
          >
            {votedOptionId && (
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${percent}%` }}
                transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                className={cn(
                  "absolute inset-y-0 left-0",
                  isSelected ? "bg-primary/25" : "bg-muted",
                )}
                aria-hidden="true"
              />
            )}
            <span className="relative flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5">
                {isSelected && (
                  <motion.span
                    initial={{ scale: 0, rotate: -45 }}
                    animate={{ scale: 1, rotate: 0 }}
                    transition={{ type: "spring", stiffness: 500, damping: 20 }}
                    className="bg-primary text-primary-foreground inline-flex size-4 shrink-0 items-center justify-center rounded-full"
                  >
                    <Check className="size-3" />
                  </motion.span>
                )}
                {option.label}
              </span>
              {votedOptionId && (
                <motion.span
                  initial={{ opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="text-muted-foreground text-xs"
                >
                  {percent}%
                </motion.span>
              )}
            </span>
          </motion.button>
        );
      })}
      <p className="text-muted-foreground text-xs">{totalVotes} votes</p>
    </div>
  );
}
