"use client";

import { useMediaQuery } from "./use-media-query";

/**
 * Single source of truth for `prefers-reduced-motion`, read by Framer Motion
 * components, GSAP timelines, and the Three.js canvas alike so every
 * animation system in the app degrades together (UI_UX.md §13).
 */
export function useReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}
