# Satoshi font files go here

UI_UX.md §4 lists Satoshi as one of the three brand typefaces. It isn't on
Google Fonts, so it can't be loaded through `next/font/google` the way Inter
and Space Grotesk are (see `src/lib/fonts.ts`).

To activate it:

1. Download the variable woff2 from https://www.fontshare.com/fonts/satoshi
   (free for commercial use under the Fontshare license).
2. Save it as `Satoshi-Variable.woff2` in this folder.
3. No code changes needed — `src/app/globals.css` already declares the
   `@font-face` rule pointing here; `--font-accent` will pick it up
   automatically once the file exists.

Until then, `--font-accent` silently falls back to Space Grotesk.
