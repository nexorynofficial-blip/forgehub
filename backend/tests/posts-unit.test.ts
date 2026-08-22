import { describe, expect, it } from "vitest";

import { MAX_MENTIONS_PER_POST, parseMentions } from "../src/modules/posts/mentions.js";
import {
  createCommentSchema,
  createPostSchema,
  feedQuerySchema,
  FEED_FILTERS,
  MAX_COMMENT_LENGTH,
  MAX_POST_LENGTH,
  newCountQuerySchema,
  postIdParamSchema,
  updatePostSchema,
  voteSchema,
} from "../src/modules/posts/posts.schema.js";
import {
  isPostListable,
  resolvePostVisibility,
  type PostVisibilityContext,
} from "../src/modules/posts/post.visibility.js";

/**
 * Unit coverage for the pure rules behind Phase 6.
 *
 * Visibility decides whether private content leaves the server, so it is
 * written as pure functions and tested without a database, a session, or an
 * HTTP request — every branch is reachable directly, including combinations
 * that are awkward to stage end to end.
 */

const base: PostVisibilityContext = {
  viewerId: "viewer-1",
  viewerRole: "member",
  authorId: "author-1",
  visibility: "public",
  deleted: false,
  authorBlockedViewer: false,
  inCommunity: false,
};

describe("Post visibility", () => {
  it("shows a public post to anyone, including anonymous callers", () => {
    expect(resolvePostVisibility(base)).toBe("full");
    expect(resolvePostVisibility({ ...base, viewerId: null, viewerRole: null })).toBe(
      "full",
    );
  });

  it("hides a private post from an unrelated viewer as not_found", () => {
    // 404 rather than 403: a 403 would confirm the post exists.
    expect(resolvePostVisibility({ ...base, visibility: "private" })).toBe("not_found");
  });

  it("shows a private post to its author", () => {
    expect(
      resolvePostVisibility({ ...base, viewerId: "author-1", visibility: "private" }),
    ).toBe("full");
  });

  it("lets each admin role through a private post", () => {
    for (const role of ["moderator", "community_admin", "platform_admin"] as const) {
      expect(
        resolvePostVisibility({ ...base, viewerRole: role, visibility: "private" }),
      ).toBe("full");
    }
  });

  it("never treats the frontend's `guest` sentinel as an admin", () => {
    expect(
      resolvePostVisibility({ ...base, viewerRole: "guest", visibility: "private" }),
    ).toBe("not_found");
  });

  it("reads an unlisted post directly but keeps it out of listings", () => {
    // "Not enumerable" is not "not readable" — the whole distinction between
    // `unlisted` and `private`.
    const unlisted = { ...base, visibility: "unlisted" as const };

    expect(resolvePostVisibility(unlisted)).toBe("full");
    expect(isPostListable(unlisted)).toBe(false);
  });

  it("resolves a soft-deleted post to not_found for everyone", () => {
    for (const context of [
      { ...base, deleted: true },
      { ...base, deleted: true, viewerId: "author-1" },
      { ...base, deleted: true, viewerRole: "platform_admin" as const },
    ]) {
      expect(resolvePostVisibility(context)).toBe("not_found");
      expect(isPostListable(context)).toBe(false);
    }
  });

  it("resolves a block to not_found, outranking every other rule", () => {
    const blocked = { ...base, authorBlockedViewer: true };

    expect(resolvePostVisibility(blocked)).toBe("not_found");
    expect(resolvePostVisibility({ ...blocked, viewerRole: "platform_admin" })).toBe(
      "not_found",
    );
    expect(isPostListable({ ...blocked, viewerRole: "platform_admin" })).toBe(false);
  });
});

describe("Community posts (decision J9)", () => {
  const communityPost = { ...base, inCommunity: true };

  it("is author-only until Phase 7 can evaluate the community", () => {
    expect(resolvePostVisibility(communityPost)).toBe("not_found");
    expect(resolvePostVisibility({ ...communityPost, viewerId: "author-1" })).toBe(
      "full",
    );
  });

  it("is hidden even from an admin, who cannot stand in for membership", () => {
    expect(
      resolvePostVisibility({ ...communityPost, viewerRole: "platform_admin" }),
    ).toBe("not_found");
  });

  it("never appears in a listing, not even for its own author", () => {
    // The feed is a cross-cutting surface; a post whose audience this phase
    // cannot compute does not belong in it.
    expect(isPostListable(communityPost)).toBe(false);
    expect(isPostListable({ ...communityPost, viewerId: "author-1" })).toBe(false);
  });
});

describe("Post listability", () => {
  it("includes a public post for anyone", () => {
    expect(isPostListable(base)).toBe(true);
    expect(isPostListable({ ...base, viewerId: null, viewerRole: null })).toBe(true);
  });

  it("omits a private post from an unrelated viewer's listing", () => {
    expect(isPostListable({ ...base, visibility: "private" })).toBe(false);
  });

  it("keeps an author's own private post in their own timeline", () => {
    expect(isPostListable({ ...base, viewerId: "author-1", visibility: "private" })).toBe(
      true,
    );
  });

  it("does not surface others' private posts to an admin's feed", () => {
    // Admins may *read* a private post; the shared feed is not a moderation
    // queue and must not quietly mix private content into it.
    expect(
      isPostListable({ ...base, viewerRole: "platform_admin", visibility: "private" }),
    ).toBe(false);
  });
});

describe("Mention parsing (decision J6)", () => {
  it("extracts a handle", () => {
    expect(parseMentions("great work @ava.codes")).toEqual(["ava.codes"]);
  });

  it("extracts several and de-duplicates", () => {
    expect(parseMentions("@ava and @riko and @ava again").sort()).toEqual([
      "ava",
      "riko",
    ]);
  });

  it("lowercases, since usernames are stored lowercase", () => {
    expect(parseMentions("hi @AvA.CoDeS")).toEqual(["ava.codes"]);
  });

  it("ignores an email address rather than mentioning its domain", () => {
    // The character before `@` must not be part of a handle.
    expect(parseMentions("write to ava@example.com")).toEqual([]);
  });

  it("trims sentence punctuation from the end of a handle", () => {
    // "ask @ava." means `ava`, not the unusable handle `ava.`
    expect(parseMentions("ask @ava.")).toEqual(["ava"]);
    expect(parseMentions("ping @riko_")).toEqual(["riko"]);
  });

  it("rejects handles shorter than the username minimum", () => {
    expect(parseMentions("@ab is too short")).toEqual([]);
  });

  it("rejects a handle with no alphanumeric character", () => {
    expect(parseMentions("@... @___")).toEqual([]);
  });

  it("ignores characters outside the username charset", () => {
    expect(parseMentions("@ava-codes")).toEqual(["ava"]);
    expect(parseMentions("@ava codes")).toEqual(["ava"]);
  });

  it("caps the number of mentions so one post cannot notify everyone", () => {
    const many = Array.from(
      { length: 25 },
      (_, i) => `@user${String(i).padStart(3, "0")}`,
    ).join(" ");
    expect(parseMentions(many)).toHaveLength(MAX_MENTIONS_PER_POST);
  });

  it("returns nothing for content with no mentions", () => {
    expect(parseMentions("just shipped the thing")).toEqual([]);
    expect(parseMentions("")).toEqual([]);
  });
});

/* ── Validation (TRD §15) ────────────────────────────────────────────────── */

describe("Post create validation", () => {
  it("accepts the shipped composer payload", () => {
    for (const type of ["text", "update", "milestone"] as const) {
      const result = createPostSchema.safeParse({ type, content: "Shipped it." });
      expect(result.success).toBe(true);
    }
  });

  it("defaults type to text", () => {
    expect(createPostSchema.parse({ content: "hello" }).type).toBe("text");
  });

  it("refuses a post with nothing in it", () => {
    expect(createPostSchema.safeParse({ content: "   " }).success).toBe(false);
    expect(createPostSchema.safeParse({}).success).toBe(false);
  });

  it("allows an empty caption when media carries the post", () => {
    const result = createPostSchema.safeParse({
      type: "image",
      content: "",
      mediaUrls: ["https://cdn.example.com/a.png"],
    });
    expect(result.success).toBe(true);
  });

  it("strips every server-owned field rather than honouring it", () => {
    const parsed = createPostSchema.parse({
      content: "Sneaky",
      authorId: "00000000-0000-4000-8000-000000000001",
      likesCount: 9_999,
      commentsCount: 9_999,
      createdAt: "2020-01-01T00:00:00.000Z",
      deletedAt: null,
    } as never);

    for (const key of [
      "authorId",
      "likesCount",
      "commentsCount",
      "createdAt",
      "deletedAt",
    ]) {
      expect(parsed).not.toHaveProperty(key);
    }
  });

  it("strips communityId, which this phase refuses outright (J9)", () => {
    const parsed = createPostSchema.parse({
      content: "For a community",
      communityId: "00000000-0000-4000-8000-000000000002",
    } as never);

    expect(parsed).not.toHaveProperty("communityId");
  });

  it("rejects a javascript: media URL (decision J11)", () => {
    // Media URLs are rendered into the DOM; z.string().url() alone accepts this.
    expect(
      createPostSchema.safeParse({ content: "x", mediaUrls: ["javascript:alert(1)"] })
        .success,
    ).toBe(false);
    expect(
      createPostSchema.safeParse({ content: "x", mediaUrls: ["data:text/html,<script>"] })
        .success,
    ).toBe(false);
  });

  it("accepts http and https media URLs", () => {
    for (const url of ["http://a.test/x.png", "https://a.test/x.png"]) {
      expect(createPostSchema.safeParse({ content: "x", mediaUrls: [url] }).success).toBe(
        true,
      );
    }
  });

  it("caps media items", () => {
    const urls = Array.from({ length: 5 }, (_, i) => `https://a.test/${String(i)}.png`);
    expect(createPostSchema.safeParse({ content: "x", mediaUrls: urls }).success).toBe(
      false,
    );
  });

  it("requires the payload that matches the declared type", () => {
    expect(createPostSchema.safeParse({ type: "code", content: "x" }).success).toBe(
      false,
    );
    expect(createPostSchema.safeParse({ type: "poll", content: "x" }).success).toBe(
      false,
    );
  });

  it("refuses a poll attached to a non-poll post", () => {
    const poll = { question: "Which?", options: ["a", "b"] };
    expect(createPostSchema.safeParse({ type: "text", content: "x", poll }).success).toBe(
      false,
    );
    expect(createPostSchema.safeParse({ type: "poll", content: "x", poll }).success).toBe(
      true,
    );
  });

  it("enforces poll option count and distinctness", () => {
    const mk = (options: string[]) => ({
      type: "poll" as const,
      content: "x",
      poll: { question: "Which?", options },
    });

    expect(createPostSchema.safeParse(mk(["only"])).success).toBe(false);
    expect(createPostSchema.safeParse(mk(["a", "A"])).success).toBe(false);
    expect(createPostSchema.safeParse(mk(["a", "b"])).success).toBe(true);
  });

  it("enforces the content length limit", () => {
    expect(
      createPostSchema.safeParse({ content: "x".repeat(MAX_POST_LENGTH + 1) }).success,
    ).toBe(false);
  });
});

describe("Post update validation", () => {
  it("rejects an empty patch rather than performing a no-op write", () => {
    expect(updatePostSchema.safeParse({}).success).toBe(false);
  });

  it("refuses to change type or rewrite a poll after the fact", () => {
    // Changing type would invalidate the stored payload; rewriting options
    // would silently reassign votes already cast.
    const parsed = updatePostSchema.parse({
      content: "edited",
      type: "poll",
      poll: { question: "New?", options: ["a", "b"] },
    } as never);

    expect(parsed).toEqual({ content: "edited" });
  });

  it("refuses to let a patch move the counters", () => {
    const parsed = updatePostSchema.parse({
      content: "edited",
      likesCount: 500,
      commentsCount: 500,
    } as never);

    expect(parsed).toEqual({ content: "edited" });
  });
});

describe("Comment validation", () => {
  it("accepts a comment and a reply", () => {
    expect(createCommentSchema.safeParse({ content: "Nice work" }).success).toBe(true);
    expect(
      createCommentSchema.safeParse({
        content: "Thanks",
        parentCommentId: "3f1e4c2a-0b6d-4e8f-9a1b-2c3d4e5f6071",
      }).success,
    ).toBe(true);
  });

  it("rejects empty and oversized content", () => {
    expect(createCommentSchema.safeParse({ content: "   " }).success).toBe(false);
    expect(
      createCommentSchema.safeParse({ content: "x".repeat(MAX_COMMENT_LENGTH + 1) })
        .success,
    ).toBe(false);
  });

  it("rejects a malformed parent id", () => {
    expect(
      createCommentSchema.safeParse({ content: "hi", parentCommentId: "nope" }).success,
    ).toBe(false);
  });
});

describe("Feed query validation", () => {
  it("defaults to latest", () => {
    expect(feedQuerySchema.parse({})).toMatchObject({ filter: "latest", limit: 20 });
  });

  it("accepts all six shipped filters, including the ai alias (J5)", () => {
    for (const filter of FEED_FILTERS) {
      expect(feedQuerySchema.safeParse({ filter }).success).toBe(true);
    }
    expect(FEED_FILTERS).toContain("ai_recommended");
  });

  it("rejects an unknown filter", () => {
    expect(feedQuerySchema.safeParse({ filter: "chronological" }).success).toBe(false);
  });

  it("caps the page size at the shared maximum", () => {
    expect(feedQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(feedQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it("requires a parsable `since` for the new-count poll", () => {
    expect(newCountQuerySchema.safeParse({}).success).toBe(false);
    expect(
      newCountQuerySchema.safeParse({ since: "2026-01-01T00:00:00.000Z" }).success,
    ).toBe(true);
  });
});

describe("Identifier validation", () => {
  it("requires a UUID, since posts have no slug", () => {
    expect(postIdParamSchema.safeParse({ id: "not-a-uuid" }).success).toBe(false);
    expect(
      postIdParamSchema.safeParse({ id: "3f1e4c2a-0b6d-4e8f-9a1b-2c3d4e5f6071" }).success,
    ).toBe(true);
  });

  it("requires a UUID for a vote's option", () => {
    expect(voteSchema.safeParse({ optionId: "1" }).success).toBe(false);
  });
});
