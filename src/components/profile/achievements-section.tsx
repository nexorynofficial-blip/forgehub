"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Award } from "lucide-react";

import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Achievement } from "@/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfettiBurst } from "@/components/motion/confetti-burst";

/** Cycled by index so a grid of badges reads as varied/collectible rather
 * than one flat accent color repeated. */
const BADGE_STYLES = [
  "bg-accent/15 text-accent",
  "bg-primary/15 text-primary",
  "bg-secondary/15 text-secondary",
  "bg-success/15 text-success",
];

function AchievementBadge({
  achievement,
  colorClass,
}: {
  achievement: Achievement;
  colorClass: string;
}) {
  const [celebrateKey, setCelebrateKey] = useState(0);

  return (
    <button
      type="button"
      onClick={() => setCelebrateKey((prev) => prev + 1)}
      aria-label={`Replay ${achievement.name} unlock celebration`}
      className="bg-surface hover:bg-muted focus-visible:ring-ring flex items-start gap-3 rounded-md p-3 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
    >
      <span
        className={cn(
          "relative flex size-9 shrink-0 items-center justify-center rounded-full",
          colorClass,
        )}
      >
        <motion.span
          key={`icon-${celebrateKey}`}
          initial={celebrateKey > 0 ? { scale: 0.6, rotate: -25 } : false}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: "spring", stiffness: 500, damping: 15 }}
          className="inline-flex"
        >
          <Award className="size-4" />
        </motion.span>
        {celebrateKey > 0 && <ConfettiBurst key={`burst-${celebrateKey}`} count={9} />}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium">{achievement.name}</p>
        <p className="text-muted-foreground mt-0.5 text-xs">{achievement.description}</p>
        {achievement.unlockedAt && (
          <p className="text-muted-foreground mt-1 text-[11px]">
            Unlocked {formatRelativeTime(achievement.unlockedAt)}
          </p>
        )}
      </div>
    </button>
  );
}

/** UI_UX.md §8 "Achievements" (PRD.md §4.10 Reputation System). Each badge
 * is clickable to replay its unlock celebration (confetti + pop) — a small
 * bit of delight since there's no live "just unlocked" event to react to
 * in this mock build. */
export function AchievementsSection({ achievements }: { achievements: Achievement[] }) {
  if (achievements.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Achievements</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2">
          {achievements.map((achievement, index) => (
            <AchievementBadge
              key={achievement.id}
              achievement={achievement}
              colorClass={BADGE_STYLES[index % BADGE_STYLES.length]}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
