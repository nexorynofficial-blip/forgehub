import { SiteFooter } from "@/components/marketing/site-footer";
import { SiteHeader } from "@/components/marketing/site-header";

/** A near-invisible film-grain layer — the single cheapest lever for making
 * large flat-black sections read as "premium dark UI" instead of "default
 * dark mode." Fixed + mix-blend-mode so it textures everything underneath
 * without ever obscuring content; a data-URI SVG turbulence filter needs no
 * network request or image asset. */
function GrainOverlay() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-50 opacity-[0.035] mix-blend-overlay"
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
      }}
    />
  );
}

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <GrainOverlay />
      <SiteHeader />
      <main id="main-content">{children}</main>
      <SiteFooter />
    </>
  );
}
