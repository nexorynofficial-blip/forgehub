/** Single source for site-wide metadata (root layout, OG/Twitter tags,
 * sitemap.ts, robots.ts) so the name/description/URL can't drift between
 * them. No real production domain exists yet (frontend-only build, no
 * deploy target chosen) — `url` is a clearly-placeholder value, same
 * convention as the `https://example.com` demo/repo URLs already used
 * throughout the mock project data. See docs/ASSUMPTIONS.md (Phase 12). */
export const siteConfig = {
  name: "ForgeHub",
  title: "ForgeHub — Build in public",
  description:
    "ForgeHub is the social platform for builders, founders, designers, and developers to build in public, gain followers, and recruit collaborators.",
  url: "https://forgehub.example",
};
