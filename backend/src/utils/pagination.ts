import { z } from "zod";

import type { Pagination } from "./response.js";

/**
 * Pagination helpers (BACKEND_TRD.md §8).
 *
 * Two strategies, deliberately both supported:
 *  - **Offset** — for stable, page-numbered lists (admin tables, search).
 *  - **Cursor** — preferred for high-volume/real-time collections (feed,
 *    messages, notifications), where offset paging drifts as rows are
 *    inserted mid-scroll and would duplicate or skip items.
 */

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

/** Query schema for offset pagination. Mount via the validation middleware. */
export const offsetPaginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type OffsetPaginationQuery = z.infer<typeof offsetPaginationSchema>;

/**
 * Query schema for cursor pagination. The cursor is opaque to clients.
 *
 * Opaque, but not unvalidated. Every cursor this codebase issues is a row id
 * from `buildCursorPage`, and every id it pages over is a `@db.Uuid` column,
 * so the cursor is checked as a UUID for the reason `posts.schema.ts` gives
 * for path ids: *"a malformed id is a 422 rather than a database trip."*
 * Without the check, `cursor: { id: <garbage> }` reaches PostgreSQL, which
 * rejects the malformed uuid with an error the handler maps to a 500.
 */
export const cursorPaginationSchema = z.object({
  cursor: z.string().uuid("Invalid cursor").optional(),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type CursorPaginationQuery = z.infer<typeof cursorPaginationSchema>;

/** Translates a validated page/limit into Prisma's `skip`/`take`. */
export function toPrismaOffset({ page, limit }: OffsetPaginationQuery): {
  skip: number;
  take: number;
} {
  return { skip: (page - 1) * limit, take: limit };
}

export function buildPagination(
  { page, limit }: OffsetPaginationQuery,
  total: number,
): Pagination {
  return {
    page,
    limit,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / limit),
  };
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Splits an over-fetched result set into a page plus the next cursor.
 *
 * Callers should query `limit + 1` rows: the extra row is what proves more
 * data exists without a second COUNT query. It is dropped from the returned
 * items and only its id becomes the cursor.
 */
export function buildCursorPage<T>(
  rows: T[],
  limit: number,
  getCursor: (item: T) => string,
): CursorPage<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);

  return {
    items,
    nextCursor: hasMore && last ? getCursor(last) : null,
  };
}
