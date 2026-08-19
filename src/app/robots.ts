import type { MetadataRoute } from "next";

import { siteConfig } from "@/lib/site-config";

/** Disallows the authenticated app shell's private sections (dashboard,
 * feed, messages, settings, admin) — profile/project/community pages stay
 * crawlable, matching how a real social platform indexes public-style
 * content but not a user's private inbox/settings. See
 * docs/ASSUMPTIONS.md (Phase 12). */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/dashboard", "/feed", "/messages", "/settings", "/admin"],
    },
    sitemap: `${siteConfig.url}/sitemap.xml`,
  };
}
