/**
 * URL slug derivation (decision J2).
 *
 * Slugs are **server-derived from the title** and never client-supplied. The
 * frontend resolves a project by slug — `/projects/[projectId]` is matched
 * against `Project.slug`, not `.id` (see `src/app/(app)/projects/[projectId]`)
 * — so the slug is a public identifier, and letting a client choose it would
 * hand out the ability to squat reserved words and impersonate routes.
 *
 * Deliberately dependency-free. Slugification is a dozen lines of string
 * handling; adding a package for it would mean touching `package.json`, which
 * Phase 5 does not do.
 */

/**
 * Leaves room for a disambiguating suffix inside the column's practical
 * budget. Titles longer than this are truncated, not rejected — a long title
 * is valid content, it just does not need to fit in a URL whole.
 */
export const MAX_SLUG_LENGTH = 80;

/** Fallback when a title slugifies to nothing (e.g. a title of only emoji). */
const FALLBACK_SLUG = "project";

/**
 * Slugs that would collide with a route segment under `/projects`.
 *
 * `trending` and `new` matter most: `/projects/trending` is a real endpoint
 * declared before `/projects/:slug`, and `/projects/new` is already linked
 * from the shipped sidebar and mobile nav. A project holding either handle
 * would be permanently unreachable — the exact class of bug the users module
 * reserves `me` to avoid.
 */
export const RESERVED_SLUGS = new Set([
  "new",
  "trending",
  "me",
  "all",
  "search",
  "api",
  "admin",
  "edit",
  "create",
  "null",
  "undefined",
]);

/**
 * Converts arbitrary text into a lowercase, hyphen-separated slug.
 *
 * The NFKD pass is what makes "Café Résumé" become `cafe-resume` rather than
 * `caf-r-sum`: decomposing first separates each accent into its own combining
 * mark, which `\p{M}` then strips, leaving the base letter behind.
 */
export function slugify(input: string): string {
  const slug = input
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    // Truncation can leave a trailing hyphen behind; trim again after it.
    .replace(/-+$/g, "");

  return slug.length > 0 ? slug : FALLBACK_SLUG;
}

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug);
}

/**
 * The nth candidate for a base slug: `forge-components`, `forge-components-2`,
 * `forge-components-3`, …
 *
 * The base is shortened rather than the suffix dropped, so every candidate
 * stays inside `MAX_SLUG_LENGTH` and the suffix — the part that makes it
 * unique — can never be the piece that gets truncated away.
 */
export function slugCandidate(base: string, attempt: number): string {
  if (attempt <= 0) return base;

  const suffix = `-${String(attempt + 1)}`;
  const room = MAX_SLUG_LENGTH - suffix.length;
  const trimmed = base.slice(0, room).replace(/-+$/g, "");

  return `${trimmed.length > 0 ? trimmed : FALLBACK_SLUG}${suffix}`;
}

/**
 * Full derivation for a title: slugify, then step past reserved handles.
 *
 * A reserved base starts at attempt 1 so "new" becomes `new-2` rather than
 * failing — the user named their project, and refusing the title because of an
 * internal routing detail would be a strange thing to explain in a form error.
 */
export function initialSlugFor(title: string): string {
  const base = slugify(title);
  return isReservedSlug(base) ? slugCandidate(base, 1) : base;
}
