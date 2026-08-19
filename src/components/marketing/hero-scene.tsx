import * as THREE from "three";

import type { SceneCanvasProps, SceneHandle } from "@/components/three";

const PARTICLE_COUNT = 160;
const BOUNDS = 7;
const CONNECTION_DISTANCE = 2.1;

/** The full brand palette (UI_UX.md §3), not just secondary cyan — cycled
 * per-particle via vertex colors so the scene reads as intentionally
 * branded rather than the generic single-hue "particle network" template. */
const PALETTE = [
  new THREE.Color(0x7c5cff), // primary
  new THREE.Color(0x00d4ff), // secondary
  new THREE.Color(0xffb800), // accent
];

/**
 * A slowly drifting constellation of connected points — "builders,
 * connected" (UI_UX.md §6 "3D Animated Background"). Connections are
 * computed once at init, not per-frame, so the render loop stays cheap.
 * Additive blending gives the points a soft glow instead of flat dots, and
 * the whole group drifts toward the cursor for a subtle parallax-to-mouse
 * feel instead of a static, merely-rotating background.
 */
export function createHeroNetworkScene({
  scene,
  camera,
}: Parameters<SceneCanvasProps["createScene"]>[0]): SceneHandle {
  const group = new THREE.Group();
  scene.add(group);

  const positions = new Float32Array(PARTICLE_COUNT * 3);
  const colors = new Float32Array(PARTICLE_COUNT * 3);
  for (let i = 0; i < PARTICLE_COUNT; i += 1) {
    positions[i * 3] = (Math.random() - 0.5) * BOUNDS * 2;
    positions[i * 3 + 1] = (Math.random() - 0.5) * BOUNDS * 2;
    positions[i * 3 + 2] = (Math.random() - 0.5) * BOUNDS;

    const color = PALETTE[i % PALETTE.length];
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }

  const pointsGeometry = new THREE.BufferGeometry();
  pointsGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  pointsGeometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const pointsMaterial = new THREE.PointsMaterial({
    size: 0.075,
    vertexColors: true,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const points = new THREE.Points(pointsGeometry, pointsMaterial);
  group.add(points);

  const linePositions: number[] = [];
  for (let i = 0; i < PARTICLE_COUNT; i += 1) {
    const ax = positions[i * 3];
    const ay = positions[i * 3 + 1];
    const az = positions[i * 3 + 2];
    for (let j = i + 1; j < PARTICLE_COUNT; j += 1) {
      const bx = positions[j * 3];
      const by = positions[j * 3 + 1];
      const bz = positions[j * 3 + 2];
      const dist = Math.hypot(ax - bx, ay - by, az - bz);
      if (dist < CONNECTION_DISTANCE) {
        linePositions.push(ax, ay, az, bx, by, bz);
      }
    }
  }

  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(linePositions), 3),
  );
  const lineMaterial = new THREE.LineBasicMaterial({
    color: 0x7c5cff,
    transparent: true,
    opacity: 0.18,
    blending: THREE.AdditiveBlending,
  });
  const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
  group.add(lines);

  const baseZ = 6;
  camera.position.z = baseZ;

  // Self-contained mouse parallax: normalized pointer position lerped into
  // the camera each frame, so the scene feels alive/responsive rather than
  // merely auto-rotating. No shared SceneCanvas plumbing needed.
  const pointer = { x: 0, y: 0 };
  function handlePointerMove(event: PointerEvent) {
    pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
    pointer.y = (event.clientY / window.innerHeight) * 2 - 1;
  }
  window.addEventListener("pointermove", handlePointerMove);

  return {
    onFrame: (t) => {
      group.rotation.y = t * 0.03;
      group.rotation.x = Math.sin(t * 0.08) * 0.05;
      camera.position.x += (pointer.x * 0.6 - camera.position.x) * 0.04;
      camera.position.y += (-pointer.y * 0.4 - camera.position.y) * 0.04;
      camera.lookAt(0, 0, 0);
    },
    dispose: () => {
      window.removeEventListener("pointermove", handlePointerMove);
      pointsGeometry.dispose();
      pointsMaterial.dispose();
      lineGeometry.dispose();
      lineMaterial.dispose();
    },
  };
}
