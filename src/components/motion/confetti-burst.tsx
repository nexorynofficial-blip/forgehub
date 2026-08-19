"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";

import { cn } from "@/lib/utils";

const COLORS = [
  "var(--color-primary)",
  "var(--color-secondary)",
  "var(--color-accent)",
  "var(--color-success)",
];

/** ~137.5°, the golden angle — spaces particles around the circle so
 * consecutive indices never land close together, without calling an
 * impure random function during render (React Compiler's purity rule). */
const GOLDEN_ANGLE = 2.399963229728653;

interface ConfettiBurstProps {
  count?: number;
  className?: string;
}

/** A small radial particle burst for celebratory moments (likes, follows,
 * achievement unlocks — UI_UX.md §5 delight/gamification). Mount it (e.g.
 * via a changing `key` on the caller's side) to fire once; it doesn't
 * re-trigger on its own. Declarative `initial`/`animate` props mean it
 * automatically no-ops under `prefers-reduced-motion` via the root
 * `MotionConfig reducedMotion="user"` (providers/app-providers.tsx). */
export function ConfettiBurst({ count = 10, className }: ConfettiBurstProps) {
  const particles = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => {
        const angle = i * GOLDEN_ANGLE;
        const distance = 20 + ((i * 7) % 11) * 2;
        return {
          id: i,
          x: Math.cos(angle) * distance,
          y: Math.sin(angle) * distance,
          color: COLORS[i % COLORS.length],
          size: 3 + ((i * 5) % 4),
        };
      }),
    [count],
  );

  return (
    <span
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0 z-10", className)}
    >
      {particles.map((particle) => (
        <motion.span
          key={particle.id}
          className="absolute top-1/2 left-1/2 rounded-full"
          style={{
            width: particle.size,
            height: particle.size,
            backgroundColor: particle.color,
          }}
          initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
          animate={{ x: particle.x, y: particle.y, opacity: 0, scale: 0.4 }}
          transition={{ duration: 0.65, ease: "easeOut" }}
        />
      ))}
    </span>
  );
}
