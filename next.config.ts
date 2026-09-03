import path from "node:path";
import type { NextConfig } from "next";
import createBundleAnalyzer from "@next/bundle-analyzer";
import { PHASE_PRODUCTION_BUILD } from "next/constants";

import { validatePublicEnv } from "./src/lib/env-contract";

const withBundleAnalyzer = createBundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pins the workspace root to this project. Without this, Next.js can
  // mis-detect the root when an unrelated lockfile exists in a parent
  // directory (e.g. the user's home folder).
  turbopack: {
    root: path.resolve(__dirname),
  },
  images: {
    formats: ["image/avif", "image/webp"],
    remotePatterns: [
      // Cloudinary is the TRD-mandated media host; widen this list as
      // real upload/CDN domains are finalized in later phases.
      { protocol: "https", hostname: "res.cloudinary.com" },
    ],
  },
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
};

/**
 * The build-time environment guard.
 *
 * `NEXT_PUBLIC_*` values are inlined into the browser bundle, so the only
 * moment a missing one can be caught is *before the bundle is written*. This
 * config is the first thing `next build` evaluates, and gating on
 * `PHASE_PRODUCTION_BUILD` is what makes the check precise: it fires for
 * `next build` and stays out of the way of `next dev` (where the localhost
 * fallbacks are correct) and `next start` (where the values are already baked
 * in and re-requiring them would be a false alarm).
 *
 * `src/lib/env.ts` applies the same rules again from module scope, so a bad
 * value cannot slip through by some path that skips this file. The rules are
 * imported from `env-contract.ts`, which reads nothing itself — importing the
 * resolving module here would fire on `next start` too, where the values are
 * already inlined.
 */
export default function config(phase: string): NextConfig {
  if (phase === PHASE_PRODUCTION_BUILD) {
    validatePublicEnv({
      apiUrl: process.env.NEXT_PUBLIC_API_URL,
      socketUrl: process.env.NEXT_PUBLIC_SOCKET_URL,
      isProduction: true,
    });
  }

  return withBundleAnalyzer(nextConfig);
}
