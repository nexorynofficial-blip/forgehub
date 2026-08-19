"use client";

import { useEffect } from "react";
import { motion, useMotionValue, useSpring } from "framer-motion";

import { useMediaQuery } from "@/hooks/use-media-query";
import { useReducedMotion } from "@/hooks/use-reduced-motion";

/**
 * Soft radial glow that trails the cursor (UI_UX.md §5 "Cursor Glow").
 * Fine-pointer desktops only — skipped on touch devices and when the user
 * prefers reduced motion.
 */
export function CursorGlow() {
  const hasFinePointer = useMediaQuery("(pointer: fine)");
  const prefersReducedMotion = useReducedMotion();

  const x = useMotionValue(-200);
  const y = useMotionValue(-200);
  const springX = useSpring(x, { stiffness: 120, damping: 20, mass: 0.5 });
  const springY = useSpring(y, { stiffness: 120, damping: 20, mass: 0.5 });

  const enabled = hasFinePointer && !prefersReducedMotion;

  useEffect(() => {
    if (!enabled) return;
    function handlePointerMove(event: PointerEvent) {
      x.set(event.clientX);
      y.set(event.clientY);
    }
    window.addEventListener("pointermove", handlePointerMove);
    return () => window.removeEventListener("pointermove", handlePointerMove);
  }, [enabled, x, y]);

  if (!enabled) return null;

  return (
    <motion.div
      aria-hidden="true"
      className="pointer-events-none fixed top-0 left-0 z-0 size-[420px] rounded-full opacity-30 blur-[100px]"
      style={{
        x: springX,
        y: springY,
        translateX: "-50%",
        translateY: "-50%",
        background:
          "radial-gradient(circle, var(--color-primary) 0%, var(--color-secondary) 45%, transparent 70%)",
      }}
    />
  );
}
