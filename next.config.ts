import path from "node:path";
import type { NextConfig } from "next";
import createBundleAnalyzer from "@next/bundle-analyzer";

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

export default withBundleAnalyzer(nextConfig);
