"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

import { cn } from "@/lib/utils";
import { useReducedMotion } from "@/hooks/use-reduced-motion";

export interface SceneHandle {
  /** Called every animation frame (skipped entirely under reduced motion). */
  onFrame?: (elapsedSeconds: number) => void;
  /** Called before the renderer/scene are torn down on unmount. */
  dispose?: () => void;
}

export interface SceneCanvasProps {
  className?: string;
  /** Builds the scene once the canvas mounts; return frame/cleanup hooks. */
  createScene: (ctx: {
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
  }) => SceneHandle | void;
}

/**
 * Generic Three.js canvas lifecycle: mounts a renderer, runs a resize
 * observer, drives (or skips, under reduced motion) the animation loop, and
 * disposes everything on unmount. Feature phases pass `createScene` to plug
 * in actual scene content (e.g. the landing hero background in Phase 02)
 * without re-implementing WebGL bookkeeping.
 *
 * Always mount this via next/dynamic with `ssr: false` — see
 * docs/ARCHITECTURE.md § Three.js.
 */
export function SceneCanvas({ className, createScene }: SceneCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const prefersReducedMotion = useReducedMotion();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.z = 5;

    const handle = createScene({ scene, camera, renderer }) ?? {};

    function resize() {
      if (!container) return;
      const { clientWidth: width, clientHeight: height } = container;
      renderer.setSize(width, height);
      camera.aspect = width / (height || 1);
      camera.updateProjectionMatrix();
    }
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    let frameId = 0;
    const clock = new THREE.Clock();

    function renderFrame() {
      handle.onFrame?.(clock.getElapsedTime());
      renderer.render(scene, camera);
      frameId = requestAnimationFrame(renderFrame);
    }

    if (prefersReducedMotion) {
      renderer.render(scene, camera);
    } else {
      frameId = requestAnimationFrame(renderFrame);
    }

    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      handle.dispose?.();
      renderer.dispose();
      container.removeChild(renderer.domElement);
    };
  }, [createScene, prefersReducedMotion]);

  return (
    <div ref={containerRef} aria-hidden="true" className={cn("size-full", className)} />
  );
}
