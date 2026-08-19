import type { MetadataRoute } from "next";

import { routes } from "@/lib/routes";
import { siteConfig } from "@/lib/site-config";

/** Only the truly static, public pages — the landing page and the five
 * `(auth)` routes. Profile/project/community pages are dynamic and backed
 * by mock data with no real database to enumerate at build time; a real
 * backend would generate their sitemap entries dynamically. See
 * docs/ASSUMPTIONS.md (Phase 12). */
export default function sitemap(): MetadataRoute.Sitemap {
  const staticPaths = [
    { path: routes.home, priority: 1, changeFrequency: "weekly" as const },
    { path: routes.auth.login, priority: 0.3, changeFrequency: "yearly" as const },
    { path: routes.auth.signup, priority: 0.5, changeFrequency: "yearly" as const },
    {
      path: routes.auth.forgotPassword,
      priority: 0.1,
      changeFrequency: "yearly" as const,
    },
  ];

  return staticPaths.map(({ path, priority, changeFrequency }) => ({
    url: `${siteConfig.url}${path}`,
    lastModified: new Date(),
    changeFrequency,
    priority,
  }));
}
