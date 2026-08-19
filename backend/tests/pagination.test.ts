import { describe, expect, it } from "vitest";

import {
  buildCursorPage,
  buildPagination,
  cursorPaginationSchema,
  offsetPaginationSchema,
  toPrismaOffset,
  MAX_PAGE_SIZE,
} from "../src/utils/pagination.js";

/**
 * TRD §8 forbids returning large collections unpaginated. These assert the
 * limits actually hold — an unbounded `limit` is the usual way that rule gets
 * bypassed in practice.
 */

describe("Offset pagination", () => {
  it("applies defaults when the client sends no pagination params", () => {
    const parsed = offsetPaginationSchema.parse({});
    expect(parsed).toEqual({ page: 1, limit: 20 });
  });

  it("coerces numeric strings, since query params arrive as strings", () => {
    const parsed = offsetPaginationSchema.parse({ page: "3", limit: "50" });
    expect(parsed).toEqual({ page: 3, limit: 50 });
  });

  it("rejects a limit above the maximum page size", () => {
    expect(() =>
      offsetPaginationSchema.parse({ limit: String(MAX_PAGE_SIZE + 1) }),
    ).toThrow();
  });

  it("rejects a zero or negative page", () => {
    expect(() => offsetPaginationSchema.parse({ page: "0" })).toThrow();
    expect(() => offsetPaginationSchema.parse({ page: "-1" })).toThrow();
  });

  it("translates page/limit into Prisma skip/take", () => {
    expect(toPrismaOffset({ page: 1, limit: 20 })).toEqual({ skip: 0, take: 20 });
    expect(toPrismaOffset({ page: 3, limit: 20 })).toEqual({ skip: 40, take: 20 });
  });

  it("computes total pages, rounding up a partial final page", () => {
    expect(buildPagination({ page: 1, limit: 20 }, 100).totalPages).toBe(5);
    expect(buildPagination({ page: 1, limit: 20 }, 101).totalPages).toBe(6);
  });

  it("reports zero pages for an empty collection rather than one empty page", () => {
    expect(buildPagination({ page: 1, limit: 20 }, 0).totalPages).toBe(0);
  });
});

describe("Cursor pagination", () => {
  it("applies a default limit and treats the cursor as optional", () => {
    expect(cursorPaginationSchema.parse({})).toEqual({ limit: 20 });
  });

  it("caps the limit at the maximum page size", () => {
    expect(() =>
      cursorPaginationSchema.parse({ limit: String(MAX_PAGE_SIZE + 1) }),
    ).toThrow();
  });

  it("drops the over-fetched row and returns its predecessor as the cursor", () => {
    // Caller queried limit+1 (3 rows for a limit of 2) to detect "has more".
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const page = buildCursorPage(rows, 2, (item) => item.id);

    expect(page.items).toEqual([{ id: "a" }, { id: "b" }]);
    expect(page.nextCursor).toBe("b");
  });

  it("returns a null cursor on the last page", () => {
    const rows = [{ id: "a" }, { id: "b" }];
    const page = buildCursorPage(rows, 2, (item) => item.id);

    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it("handles an empty result set", () => {
    const page = buildCursorPage([], 20, (item: { id: string }) => item.id);
    expect(page).toEqual({ items: [], nextCursor: null });
  });
});
