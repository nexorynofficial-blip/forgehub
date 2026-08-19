"use client";

import { useEffect, useRef } from "react";
import { animate, useInView, useMotionValue, useReducedMotion } from "framer-motion";

interface AnimatedCounterProps {
  value: number;
  format?: (value: number) => string;
  className?: string;
  duration?: number;
}

/** Counts up from 0 to `value` once it scrolls into view (UI_UX.md §6 "Animated Statistics"). */
export function AnimatedCounter({
  value,
  format = (n) => Math.round(n).toLocaleString(),
  className,
  duration = 1.4,
}: AnimatedCounterProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-80px" });
  const prefersReducedMotion = useReducedMotion();
  const motionValue = useMotionValue(0);

  // Writes directly to the DOM via Framer's subscription instead of React
  // state, so the tween doesn't trigger a re-render on every frame.
  useEffect(() => {
    return motionValue.on("change", (latest) => {
      if (ref.current) ref.current.textContent = format(latest);
    });
  }, [motionValue, format]);

  useEffect(() => {
    if (!isInView) return;
    if (prefersReducedMotion) {
      motionValue.set(value);
      return;
    }
    const controls = animate(motionValue, value, {
      duration,
      ease: [0.16, 1, 0.3, 1],
    });
    return () => controls.stop();
  }, [isInView, prefersReducedMotion, value, duration, motionValue]);

  return (
    <span ref={ref} className={className}>
      {format(0)}
    </span>
  );
}
