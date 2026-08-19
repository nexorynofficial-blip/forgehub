"use client";

import { useEffect, useRef, useState } from "react";

/** Reports whether the returned ref's element is on-screen — used to fire
 * `fetchNextPage()` when an infinite scroll sentinel becomes visible. */
export function useIntersectionObserver<T extends HTMLElement>(
  options?: IntersectionObserverInit,
) {
  const ref = useRef<T>(null);
  const [isIntersecting, setIsIntersecting] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const observer = new IntersectionObserver(([entry]) => {
      setIsIntersecting(entry.isIntersecting);
    }, options);

    observer.observe(node);
    return () => observer.disconnect();
  }, [options]);

  return { ref, isIntersecting };
}
