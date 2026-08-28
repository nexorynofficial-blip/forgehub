import { describe, expect, it } from "vitest";

import {
  MAX_QUERY_LENGTH,
  SEARCH_ENTITIES,
  SEARCH_SORTS,
  SEARCH_TYPES,
  effectiveViewerRole,
  isCommunityDiscoverable,
  isEffectivelyEmpty,
  isPostDiscoverable,
  isProjectDiscoverable,
  isSearchSort,
  isTagDiscoverable,
  isUsableQuery,
  isUserDiscoverable,
  normalizeQuery,
  shouldSearch,
  type OwnedVisibilityContext,
  type PostVisibilityContext,
  type UserVisibilityContext,
} from "../src/modules/search/search.access.js";
import { searchQuerySchema } from "../src/modules/search/search.schema.js";

/**
 * The search visibility matrix and query rules (PRD §15, TRD §24,
 * ARCHITECTURE §24).
 *
 * These functions decide which rows one user may discover about another, so
 * they are tested exhaustively rather than by example: every visibility value
 * against every viewer relationship, and both query-normalization edges.
 *
 * Pure, so no database, no mocks, no server.
 */

/* ── Query normalization (ruling D11) ────────────────────────────────────── */

describe("normalizeQuery", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeQuery("  react  ")).toBe("react");
  });

  it("collapses internal whitespace", () => {
    expect(normalizeQuery("open   source   tools")).toBe("open source tools");
  });

  it("collapses tabs and newlines too", () => {
    expect(normalizeQuery("open\t\nsource")).toBe("open source");
  });

  it("leaves an ordinary term alone", () => {
    expect(normalizeQuery("TypeScript")).toBe("TypeScript");
  });

  it("does not case-fold — that is the database's job", () => {
    // `ILIKE` handles case. Folding here would make the echoed `query` in the
    // response disagree with what the user typed.
    expect(normalizeQuery("TypeScript")).not.toBe("typescript");
  });
});

describe("isEffectivelyEmpty", () => {
  it("rejects an empty string", () => {
    expect(isEffectivelyEmpty("")).toBe(true);
  });

  it("rejects a wildcard-only term", () => {
    // `%` alone compiles to `ILIKE '%%%'`, which matches every row and turns
    // search into a bulk dump of everything the viewer may see.
    for (const term of ["%", "%%", "_", "__", "%_%", "% %"]) {
      expect(isEffectivelyEmpty(term), term).toBe(true);
    }
  });

  it("accepts a term that merely contains a wildcard", () => {
    // `snake_case` and `100%` are real searches on a builder platform. They
    // over-match — an `_` also matches any character — but they never
    // under-match, and over-matching is a precision loss, not a leak.
    for (const term of ["snake_case", "100%", "a_b", "%off"]) {
      expect(isEffectivelyEmpty(term), term).toBe(false);
    }
  });

  it("accepts an ordinary term", () => {
    expect(isEffectivelyEmpty("react")).toBe(false);
  });
});

describe("isUsableQuery", () => {
  it("accepts an ordinary term", () => {
    expect(isUsableQuery("react")).toBe(true);
  });

  it("rejects whitespace-only input", () => {
    for (const term of ["", " ", "   ", "\t", "\n", " \t \n "]) {
      expect(isUsableQuery(term), JSON.stringify(term)).toBe(false);
    }
  });

  it("accepts a single character", () => {
    expect(isUsableQuery("a")).toBe(true);
  });

  it("rejects a term longer than the maximum", () => {
    expect(isUsableQuery("x".repeat(MAX_QUERY_LENGTH))).toBe(true);
    expect(isUsableQuery("x".repeat(MAX_QUERY_LENGTH + 1))).toBe(false);
  });
});

describe("searchQuerySchema", () => {
  it("normalizes the term before validating its length", () => {
    // A naive `min(1)` would pass "   "; the transform runs first so it fails.
    expect(searchQuerySchema.safeParse({ q: "   " }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ q: "  react  " }).data?.q).toBe("react");
  });

  it("rejects a wildcard-only term", () => {
    expect(searchQuerySchema.safeParse({ q: "%" }).success).toBe(false);
  });

  it("rejects a missing term", () => {
    expect(searchQuerySchema.safeParse({}).success).toBe(false);
  });

  it("defaults type, sort, page, and limit", () => {
    const parsed = searchQuerySchema.parse({ q: "react" });
    expect(parsed).toMatchObject({ type: "all", sort: "recent", page: 1, limit: 20 });
  });

  it("rejects an unknown type", () => {
    expect(searchQuerySchema.safeParse({ q: "a", type: "messages" }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ q: "a", type: "notifications" }).success).toBe(
      false,
    );
  });

  it("rejects an unknown sort", () => {
    // A sort key never reaches the database as a string; the closed union is
    // what stops caller text reaching an `orderBy`.
    expect(searchQuerySchema.safeParse({ q: "a", sort: "relevance" }).success).toBe(
      false,
    );
    expect(searchQuerySchema.safeParse({ q: "a", sort: "xp" }).success).toBe(false);
  });

  it("clamps an oversized limit rather than rejecting it", () => {
    expect(searchQuerySchema.parse({ q: "a", limit: "5000" }).limit).toBe(100);
  });

  it("rejects a non-positive page or limit", () => {
    expect(searchQuerySchema.safeParse({ q: "a", page: "0" }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ q: "a", limit: "-1" }).success).toBe(false);
  });

  it("coerces numeric strings, since a query string has no numbers", () => {
    const parsed = searchQuerySchema.parse({ q: "a", page: "3", limit: "5" });
    expect(parsed.page).toBe(3);
    expect(parsed.limit).toBe(5);
  });

  it("strips a client-supplied userId", () => {
    // The structural defence against evaluating visibility as someone else.
    const parsed = searchQuerySchema.parse({ q: "a", userId: "someone-else" });
    expect(parsed).not.toHaveProperty("userId");
  });
});

/* ── Group selection and sorting ─────────────────────────────────────────── */

describe("shouldSearch", () => {
  it("queries every entity for type=all", () => {
    for (const entity of SEARCH_ENTITIES) {
      expect(shouldSearch(entity, "all"), entity).toBe(true);
    }
  });

  it("queries exactly one entity for a specific type", () => {
    for (const target of SEARCH_ENTITIES) {
      for (const entity of SEARCH_ENTITIES) {
        expect(shouldSearch(entity, target), `${target}/${entity}`).toBe(
          entity === target,
        );
      }
    }
  });
});

describe("the type and sort allow-lists", () => {
  it("names exactly the five ruled-in entities plus all", () => {
    expect([...SEARCH_TYPES].sort()).toEqual([
      "all",
      "communities",
      "posts",
      "projects",
      "tags",
      "users",
    ]);
  });

  it("offers no messages, notifications, or comments type", () => {
    // Phase-boundary guard: those were deferred, and a type value is the only
    // way one could reach the repository.
    for (const excluded of ["messages", "notifications", "comments", "achievements"]) {
      expect((SEARCH_TYPES as readonly string[]).includes(excluded), excluded).toBe(
        false,
      );
    }
  });

  it("offers no relevance sort", () => {
    // Ruling D6: ILIKE yields a boolean, not a rank; there is nothing to score.
    expect([...SEARCH_SORTS].sort()).toEqual(["popular", "recent"]);
    expect(isSearchSort("relevance")).toBe(false);
    expect(isSearchSort("recent")).toBe(true);
  });
});

/* ── Visibility: users ───────────────────────────────────────────────────── */

const USER: UserVisibilityContext = {
  viewerId: "viewer",
  targetId: "target",
  deleted: false,
  targetVisibility: "public",
  isFollowing: false,
  targetBlockedViewer: false,
};

function user(overrides: Partial<UserVisibilityContext> = {}): UserVisibilityContext {
  return { ...USER, ...overrides };
}

describe("isUserDiscoverable", () => {
  it("finds a public profile", () => {
    expect(isUserDiscoverable(user())).toBe(true);
  });

  it("finds a public profile anonymously", () => {
    expect(isUserDiscoverable(user({ viewerId: null }))).toBe(true);
  });

  it("hides a soft-deleted account from everyone", () => {
    expect(isUserDiscoverable(user({ deleted: true }))).toBe(false);
    expect(isUserDiscoverable(user({ deleted: true, viewerId: "target" }))).toBe(false);
  });

  it("hides someone who blocked the viewer", () => {
    expect(isUserDiscoverable(user({ targetBlockedViewer: true }))).toBe(false);
  });

  it("puts blocking ahead of self and of a public setting", () => {
    // Blocking outranks everything, unbroken since Phase 4.
    expect(
      isUserDiscoverable(
        user({
          targetBlockedViewer: true,
          targetVisibility: "public",
          isFollowing: true,
        }),
      ),
    ).toBe(false);
  });

  it("hides a followers-only profile from a stranger", () => {
    expect(isUserDiscoverable(user({ targetVisibility: "followers" }))).toBe(false);
  });

  it("hides a followers-only profile from an anonymous viewer", () => {
    expect(
      isUserDiscoverable(user({ targetVisibility: "followers", viewerId: null })),
    ).toBe(false);
  });

  it("shows a followers-only profile to a follower", () => {
    expect(
      isUserDiscoverable(user({ targetVisibility: "followers", isFollowing: true })),
    ).toBe(true);
  });

  it("always finds yourself, whatever your setting", () => {
    expect(
      isUserDiscoverable(
        user({ viewerId: "target", targetVisibility: "followers", isFollowing: false }),
      ),
    ).toBe(true);
  });

  it("decides consistently across every combination", () => {
    for (const deleted of [true, false]) {
      for (const blocked of [true, false]) {
        for (const visibility of ["public", "followers"] as const) {
          for (const following of [true, false]) {
            for (const viewerId of ["viewer", "target", null]) {
              const decision = isUserDiscoverable(
                user({
                  viewerId,
                  deleted,
                  targetBlockedViewer: blocked,
                  targetVisibility: visibility,
                  isFollowing: following,
                }),
              );

              const isSelf = viewerId === "target";
              const expected =
                !deleted &&
                !blocked &&
                (isSelf || visibility === "public" || (viewerId !== null && following));

              expect(
                decision,
                `deleted=${String(deleted)} blocked=${String(blocked)} vis=${visibility} following=${String(following)} viewer=${String(viewerId)}`,
              ).toBe(expected);
            }
          }
        }
      }
    }
  });
});

/* ── Visibility: projects and communities ────────────────────────────────── */

const OWNED: OwnedVisibilityContext = {
  viewerId: "viewer",
  ownerId: "owner",
  deleted: false,
  visibility: "public",
  isMember: false,
  ownerBlockedViewer: false,
};

function owned(overrides: Partial<OwnedVisibilityContext> = {}): OwnedVisibilityContext {
  return { ...OWNED, ...overrides };
}

describe("isProjectDiscoverable", () => {
  it("finds a public project", () => {
    expect(isProjectDiscoverable(owned())).toBe(true);
    expect(isProjectDiscoverable(owned({ viewerId: null }))).toBe(true);
  });

  it("hides a soft-deleted project from everyone, owner included", () => {
    expect(isProjectDiscoverable(owned({ deleted: true }))).toBe(false);
    expect(isProjectDiscoverable(owned({ deleted: true, viewerId: "owner" }))).toBe(
      false,
    );
  });

  it("hides a private project from a stranger", () => {
    expect(isProjectDiscoverable(owned({ visibility: "private" }))).toBe(false);
  });

  it("shows a private project to its owner and to a member", () => {
    expect(
      isProjectDiscoverable(owned({ visibility: "private", viewerId: "owner" })),
    ).toBe(true);
    expect(isProjectDiscoverable(owned({ visibility: "private", isMember: true }))).toBe(
      true,
    );
  });

  it("hides an unlisted project from a stranger", () => {
    // "Reachable by link, not by listing" — and a search result is a listing.
    expect(isProjectDiscoverable(owned({ visibility: "unlisted" }))).toBe(false);
    expect(isProjectDiscoverable(owned({ visibility: "unlisted", viewerId: null }))).toBe(
      false,
    );
  });

  it("shows an unlisted project to its owner and members", () => {
    expect(
      isProjectDiscoverable(owned({ visibility: "unlisted", viewerId: "owner" })),
    ).toBe(true);
    expect(isProjectDiscoverable(owned({ visibility: "unlisted", isMember: true }))).toBe(
      true,
    );
  });

  it("hides everything from a viewer the owner blocked", () => {
    expect(isProjectDiscoverable(owned({ ownerBlockedViewer: true }))).toBe(false);
    expect(
      isProjectDiscoverable(owned({ ownerBlockedViewer: true, isMember: true })),
    ).toBe(false);
  });

  it("shows anonymous viewers public projects only", () => {
    for (const visibility of ["private", "unlisted"] as const) {
      expect(
        isProjectDiscoverable(owned({ viewerId: null, visibility })),
        visibility,
      ).toBe(false);
    }
  });

  it("gives communities the same rules", () => {
    for (const visibility of ["public", "private", "unlisted"] as const) {
      for (const isMember of [true, false]) {
        const context = owned({ visibility, isMember });
        expect(
          isCommunityDiscoverable(context),
          `${visibility}/${String(isMember)}`,
        ).toBe(isProjectDiscoverable(context));
      }
    }
  });
});

/* ── Visibility: posts ───────────────────────────────────────────────────── */

const POST: PostVisibilityContext = {
  viewerId: "viewer",
  authorId: "author",
  deleted: false,
  visibility: "public",
  communityVisibility: null,
  communityDeleted: false,
  authorBlockedViewer: false,
};

function post(overrides: Partial<PostVisibilityContext> = {}): PostVisibilityContext {
  return { ...POST, ...overrides };
}

describe("isPostDiscoverable", () => {
  it("finds a public standalone post", () => {
    expect(isPostDiscoverable(post())).toBe(true);
    expect(isPostDiscoverable(post({ viewerId: null }))).toBe(true);
  });

  it("hides a soft-deleted post from its own author", () => {
    expect(isPostDiscoverable(post({ deleted: true, viewerId: "author" }))).toBe(false);
  });

  it("hides a non-public post from a stranger", () => {
    for (const visibility of ["private", "unlisted"] as const) {
      expect(isPostDiscoverable(post({ visibility })), visibility).toBe(false);
    }
  });

  it("shows the author their own non-public post", () => {
    expect(isPostDiscoverable(post({ visibility: "private", viewerId: "author" }))).toBe(
      true,
    );
  });

  it("finds a public post in a public community", () => {
    expect(isPostDiscoverable(post({ communityVisibility: "public" }))).toBe(true);
  });

  it("hides a public post inside a private community", () => {
    // Membership is deliberately not consulted — the Phase 6 feed decision.
    expect(isPostDiscoverable(post({ communityVisibility: "private" }))).toBe(false);
    expect(isPostDiscoverable(post({ communityVisibility: "unlisted" }))).toBe(false);
  });

  it("hides a post whose community was soft-deleted", () => {
    expect(
      isPostDiscoverable(post({ communityVisibility: "public", communityDeleted: true })),
    ).toBe(false);
  });

  it("puts the community rule ahead of authorship", () => {
    // An author's own post in a private community stays out of global search.
    expect(
      isPostDiscoverable(post({ viewerId: "author", communityVisibility: "private" })),
    ).toBe(false);
  });

  it("hides everything from a viewer the author blocked", () => {
    expect(isPostDiscoverable(post({ authorBlockedViewer: true }))).toBe(false);
  });
});

/* ── Tags and the admin guard ────────────────────────────────────────────── */

describe("isTagDiscoverable", () => {
  it("is unconditionally true", () => {
    // Curated taxonomy: no visibility column, no soft delete, no owner.
    expect(isTagDiscoverable()).toBe(true);
  });
});

describe("effectiveViewerRole", () => {
  it("discards every role, including the admin ones", () => {
    // Ruling D8 as a property rather than an assumption: search visibility is
    // a function of identity and relationship, never of standing.
    for (const role of [
      "guest",
      "member",
      "verified_builder",
      "moderator",
      "community_admin",
      "platform_admin",
      null,
    ] as const) {
      expect(effectiveViewerRole(role), String(role)).toBeNull();
    }
  });

  it("takes no role in any visibility predicate", () => {
    // The predicates have no role parameter at all — asserted structurally by
    // the fact that every context type above compiles without one.
    const contexts = Object.keys(USER).concat(Object.keys(OWNED), Object.keys(POST));
    expect(contexts).not.toContain("role");
    expect(contexts).not.toContain("viewerRole");
  });
});
