"use client";

import { useLayoutEffect } from "react";

/** Locks page scroll while `locked` is true — used by mobile sheets/drawers (UI_UX.md §11). */
export function useLockBodyScroll(locked: boolean): void {
  useLayoutEffect(() => {
    if (!locked) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [locked]);
}
