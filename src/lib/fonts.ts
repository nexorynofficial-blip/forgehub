import { Inter, Space_Grotesk } from "next/font/google";

/**
 * UI_UX.md §4 names three families: Inter, Space Grotesk, Satoshi.
 * The spec doesn't assign a role to each, so this maps them by convention:
 *  - Inter        -> --font-sans (body copy, UI chrome, forms)
 *  - Space Grotesk -> --font-display (headings, stats, nav)
 *  - Satoshi       -> --font-accent (hero/marketing emphasis only)
 * Satoshi isn't on Google Fonts, so it's loaded via manual @font-face in
 * globals.css instead of next/font/local (see docs/ASSUMPTIONS.md).
 */

export const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  display: "swap",
});

export const fontVariables = `${inter.variable} ${spaceGrotesk.variable}`;
