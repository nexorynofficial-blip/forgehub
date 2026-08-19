"use client";

import dynamic from "next/dynamic";

export type { SceneCanvasProps, SceneHandle } from "./scene-canvas";

/**
 * Three.js touches `window`/WebGL at module scope, so it can never run on
 * the server. Always import the canvas through this lazy wrapper instead of
 * `./scene-canvas` directly.
 */
export const SceneCanvas = dynamic(
  () => import("./scene-canvas").then((m) => m.SceneCanvas),
  {
    ssr: false,
  },
);
