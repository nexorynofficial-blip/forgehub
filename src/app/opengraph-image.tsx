import { ImageResponse } from "next/og";

import { siteConfig } from "@/lib/site-config";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** Generated, not a static asset — no real brand image exists anywhere in
 * this build (every avatar/banner/cover is a `null`-with-fallback
 * placeholder), so a programmatic OG image is the honest way to give link
 * previews something better than nothing. See docs/ASSUMPTIONS.md
 * (Phase 12). */
export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "80px",
        backgroundColor: "#09090B",
        backgroundImage:
          "radial-gradient(circle at 15% 20%, rgba(124,92,255,0.35), transparent 55%), " +
          "radial-gradient(circle at 85% 80%, rgba(0,212,255,0.25), transparent 50%)",
      }}
    >
      <div style={{ display: "flex", fontSize: 72, fontWeight: 700, color: "#FAFAFA" }}>
        Forge
        <span style={{ color: "#7C5CFF" }}>Hub</span>
      </div>
      <div
        style={{
          display: "flex",
          marginTop: 24,
          fontSize: 32,
          color: "#A1A1AA",
          maxWidth: 820,
        }}
      >
        {siteConfig.description}
      </div>
    </div>,
    { ...size },
  );
}
