import { z } from "zod";

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../../utils/pagination.js";
import {
  MAX_QUERY_LENGTH,
  SEARCH_SORTS,
  SEARCH_TYPES,
  isEffectivelyEmpty,
  normalizeQuery,
} from "./search.access.js";

/**
 * Request validation for `GET /api/v1/search` (Phase 10).
 *
 * Zod strips unknown keys, which is the house defence against client-supplied
 * server-owned fields — the same property Phases 5–9 rely on. It is load-
 * bearing here in a way it has not been before: **a `userId` in the query
 * string is silently discarded**, so no request can redirect whose visibility
 * the search is evaluated against. Identity comes from the verified access
 * token in the controller and nowhere else.
 *
 * `sort` and `type` are `z.enum`s rather than free strings so an unknown value
 * is a 422 at the edge, and the repository can switch on a closed union rather
 * than interpolate a caller's text into an `orderBy`.
 */

/**
 * The search term.
 *
 * Trimmed and whitespace-collapsed by `normalizeQuery` before any length check
 * runs, so `"   "` fails as empty rather than passing a naive `min(1)`
 * (ruling D11). The wildcard-only refusal is explained in `search.access.ts`;
 * in short, `%` alone would compile to `ILIKE '%%%'` and enumerate everything
 * the viewer may see.
 */
const searchTerm = z
  .string({ message: "A search term is required" })
  .transform(normalizeQuery)
  .refine((value) => !isEffectivelyEmpty(value), {
    message: "A search term is required",
  })
  .refine((value) => value.length <= MAX_QUERY_LENGTH, {
    message: `A search term may be at most ${String(MAX_QUERY_LENGTH)} characters`,
  });

/**
 * Offset pagination, applied **per entity group**.
 *
 * Offset rather than cursor (ruling D7), for the reason `utils/pagination.ts`
 * and `docs/DATABASE.md` both already record: search is a stable,
 * page-numbered list. A cross-entity result set also has no single cursor
 * column — five tables, five id spaces — so a cursor could not address it.
 *
 * `limit` **clamps** rather than rejects, which is the one deliberate
 * deviation from `offsetPaginationSchema`. That shared schema uses
 * `.max(MAX_PAGE_SIZE)`, which 422s an oversized page; the Phase 10 brief
 * requires an oversized limit to be clamped. `MAX_PAGE_SIZE` and
 * `DEFAULT_PAGE_SIZE` themselves are reused unchanged, so the ceiling stays
 * defined in exactly one place.
 */
export const searchQuerySchema = z.object({
  q: searchTerm,
  type: z.enum(SEARCH_TYPES).default("all"),
  sort: z.enum(SEARCH_SORTS).default("recent"),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_PAGE_SIZE)
    .transform((value) => Math.min(value, MAX_PAGE_SIZE)),
});

export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type SearchType = SearchQuery["type"];
export type SearchSort = SearchQuery["sort"];
