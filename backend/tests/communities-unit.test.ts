import type { CommunityRole, UserRole } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  ASSIGNABLE_COMMUNITY_ROLES,
  can,
  canAssignRole,
  canManageMemberAt,
  canRemovePost,
  MODERATING_ROLES,
  ROLE_PERMISSIONS,
  type CommunityAccessContext,
  type CommunityAction,
} from "../src/modules/communities/community.access.js";
import {
  canAccessCommunityPost,
  isCommunityListable,
  isCommunityPostGloballyListable,
  resolveCommunityVisibility,
  resolveJoin,
  type CommunityVisibilityContext,
} from "../src/modules/communities/community.visibility.js";
import {
  COMMUNITY_SORTS,
  addMemberSchema,
  communityListQuerySchema,
  communitySlugParamSchema,
  createCommunitySchema,
  createEventSchema,
  memberRoleSchema,
  pinPostSchema,
  replaceRulesSchema,
  transferOwnershipSchema,
  updateCommunitySchema,
  updateEventSchema,
} from "../src/modules/communities/communities.schema.js";

/**
 * Unit coverage for the pure rules behind Phase 7.
 *
 * Visibility and access decide whether private content leaves the server and
 * who may rewrite a community, so both are written as pure functions and
 * tested without a database, a session, or an HTTP request — every branch is
 * reachable directly, including combinations that are awkward to stage end to
 * end.
 *
 * The access table is enumerated exhaustively rather than sampled: a
 * permission table is only trustworthy if every (action × role) pair has been
 * looked at, and sampling is how a stray grant survives review.
 */

const ADMIN_ROLES: UserRole[] = ["moderator", "community_admin", "platform_admin"];
const ALL_COMMUNITY_ROLES: CommunityRole[] = ["owner", "admin", "moderator", "member"];

/* ══ Visibility ═══════════════════════════════════════════════════════════ */

const base: CommunityVisibilityContext = {
  viewerId: "viewer-1",
  viewerRole: "member",
  ownerId: "owner-1",
  visibility: "public",
  deleted: false,
  isMember: false,
  ownerBlockedViewer: false,
};

describe("Community visibility", () => {
  it("shows a public community to anyone, including anonymous callers", () => {
    expect(resolveCommunityVisibility(base)).toBe("full");
    expect(
      resolveCommunityVisibility({ ...base, viewerId: null, viewerRole: null }),
    ).toBe("full");
  });

  it("hides a private community from an unrelated viewer as not_found", () => {
    // 404 rather than 403: a 403 would confirm the community exists.
    expect(resolveCommunityVisibility({ ...base, visibility: "private" })).toBe(
      "not_found",
    );
  });

  it("shows a private community to its owner and to its members", () => {
    expect(
      resolveCommunityVisibility({
        ...base,
        visibility: "private",
        viewerId: "owner-1",
      }),
    ).toBe("full");
    expect(
      resolveCommunityVisibility({ ...base, visibility: "private", isMember: true }),
    ).toBe("full");
  });

  it("lets each admin role through a private community", () => {
    for (const role of ADMIN_ROLES) {
      expect(
        resolveCommunityVisibility({
          ...base,
          visibility: "private",
          viewerRole: role,
        }),
      ).toBe("full");
    }
  });

  it("treats a soft-deleted community as not_found even for its owner", () => {
    // A deleted community is not a privacy question — rule 1.
    expect(
      resolveCommunityVisibility({ ...base, deleted: true, viewerId: "owner-1" }),
    ).toBe("not_found");
  });

  it("lets blocking outrank membership, ownership, and the admin role", () => {
    for (const context of [
      { viewerId: "owner-1" },
      { isMember: true },
      { viewerRole: "platform_admin" as UserRole },
    ]) {
      expect(
        resolveCommunityVisibility({
          ...base,
          ...context,
          ownerBlockedViewer: true,
        }),
      ).toBe("not_found");
    }
  });

  it("reads an unlisted community directly but keeps it out of listings", () => {
    // The whole distinction PRD §6 draws: not enumerable, still readable.
    const unlisted = { ...base, visibility: "unlisted" as const };
    expect(resolveCommunityVisibility(unlisted)).toBe("full");
    expect(isCommunityListable(unlisted)).toBe(false);
  });
});

describe("Community listability", () => {
  it("lists a public community for everyone", () => {
    expect(isCommunityListable(base)).toBe(true);
    expect(isCommunityListable({ ...base, viewerId: null, viewerRole: null })).toBe(true);
  });

  it("omits a private community from an unrelated viewer's listing", () => {
    expect(isCommunityListable({ ...base, visibility: "private" })).toBe(false);
  });

  it("keeps a private community in its own owner's and members' listings", () => {
    expect(
      isCommunityListable({ ...base, visibility: "private", viewerId: "owner-1" }),
    ).toBe(true);
    expect(isCommunityListable({ ...base, visibility: "private", isMember: true })).toBe(
      true,
    );
  });

  it("omits a deleted or blocked community from every listing", () => {
    expect(isCommunityListable({ ...base, deleted: true, viewerId: "owner-1" })).toBe(
      false,
    );
    expect(
      isCommunityListable({ ...base, ownerBlockedViewer: true, isMember: true }),
    ).toBe(false);
  });
});

/* ══ Community posts — the Phase 6 seam (decision J2) ═════════════════════ */

describe("Community post access", () => {
  const postBase = {
    viewerId: "viewer-1",
    viewerRole: "member" as UserRole | null,
    communityVisibility: "public" as const,
    communityDeleted: false,
    isMember: false,
  };

  it("lets anyone read a post in a public community", () => {
    expect(canAccessCommunityPost(postBase)).toBe(true);
    expect(
      canAccessCommunityPost({ ...postBase, viewerId: null, viewerRole: null }),
    ).toBe(true);
  });

  it("lets anyone read a post in an unlisted community", () => {
    // Unlisted protects enumeration, not the contents.
    expect(canAccessCommunityPost({ ...postBase, communityVisibility: "unlisted" })).toBe(
      true,
    );
  });

  it("refuses a private community's post to a non-member", () => {
    expect(canAccessCommunityPost({ ...postBase, communityVisibility: "private" })).toBe(
      false,
    );
  });

  it("allows a private community's post to a member", () => {
    expect(
      canAccessCommunityPost({
        ...postBase,
        communityVisibility: "private",
        isMember: true,
      }),
    ).toBe(true);
  });

  it("allows a private community's post to each admin role", () => {
    // Phase 6's placeholder deliberately refused the admin bypass because it
    // could not perform the membership test. Now that it can, the bypass is
    // honoured again.
    for (const role of ADMIN_ROLES) {
      expect(
        canAccessCommunityPost({
          ...postBase,
          communityVisibility: "private",
          viewerRole: role,
        }),
      ).toBe(true);
    }
  });

  it("takes a deleted community's posts with it, for everyone (decision J13)", () => {
    for (const visibility of ["public", "unlisted", "private"] as const) {
      expect(
        canAccessCommunityPost({
          ...postBase,
          communityVisibility: visibility,
          communityDeleted: true,
          isMember: true,
          viewerRole: "platform_admin",
        }),
      ).toBe(false);
    }
  });
});

describe("Community posts in the global feed", () => {
  it("enumerates public-community posts only", () => {
    expect(
      isCommunityPostGloballyListable({
        communityVisibility: "public",
        communityDeleted: false,
      }),
    ).toBe(true);

    for (const visibility of ["private", "unlisted"] as const) {
      expect(
        isCommunityPostGloballyListable({
          communityVisibility: visibility,
          communityDeleted: false,
        }),
      ).toBe(false);
    }
  });

  it("omits a deleted community's posts", () => {
    expect(
      isCommunityPostGloballyListable({
        communityVisibility: "public",
        communityDeleted: true,
      }),
    ).toBe(false);
  });
});

/* ══ Joining (decision J5) ════════════════════════════════════════════════ */

describe("Join resolution", () => {
  it("allows an immediate self-join to a public community", () => {
    expect(resolveJoin({ visibility: "public", isMember: false })).toEqual({
      allowed: true,
    });
  });

  it("allows a self-join to an unlisted community reached by slug", () => {
    expect(resolveJoin({ visibility: "unlisted", isMember: false })).toEqual({
      allowed: true,
    });
  });

  it("refuses a self-join to a private community", () => {
    // No pending state: there is no table to persist one (decision J5).
    expect(resolveJoin({ visibility: "private", isMember: false })).toEqual({
      allowed: false,
      reason: "private",
    });
  });

  it("reports an existing membership distinctly from a refusal", () => {
    // The service maps these to different statuses — 409 vs 403.
    expect(resolveJoin({ visibility: "public", isMember: true })).toEqual({
      allowed: false,
      reason: "already_member",
    });
  });

  it("reports an existing membership even in a private community", () => {
    expect(resolveJoin({ visibility: "private", isMember: true })).toEqual({
      allowed: false,
      reason: "already_member",
    });
  });
});

/* ══ Access table ═════════════════════════════════════════════════════════ */

const accessBase: CommunityAccessContext = {
  isOwner: false,
  memberRole: null,
  viewerRole: null,
};

const ALL_ACTIONS: CommunityAction[] = [
  "edit_community",
  "delete_community",
  "transfer_ownership",
  "manage_members",
  "assign_admin_role",
  "manage_rules",
  "manage_events",
  "pin_posts",
  "remove_posts",
  "create_post",
];

describe("Community access table", () => {
  it("grants the owner of record every action", () => {
    for (const action of ALL_ACTIONS) {
      expect(can(action, { ...accessBase, isOwner: true })).toBe(true);
    }
  });

  it("refuses every action to an anonymous, non-member caller", () => {
    for (const action of ALL_ACTIONS) {
      expect(can(action, accessBase)).toBe(false);
    }
  });

  it("matches the declared table for every (action × role) pair", () => {
    // Exhaustive rather than sampled: the table is only trustworthy if every
    // cell has been asserted.
    for (const role of ALL_COMMUNITY_ROLES) {
      for (const action of ALL_ACTIONS) {
        const granted = ROLE_PERMISSIONS[role].includes(action);
        expect(can(action, { ...accessBase, memberRole: role })).toBe(granted);
      }
    }
  });

  it("keeps ownership transfer and admin assignment owner-only", () => {
    for (const action of ["transfer_ownership", "assign_admin_role"] as const) {
      // Not reachable by a community admin…
      expect(can(action, { ...accessBase, memberRole: "admin" })).toBe(false);
      // …nor by a platform admin.
      for (const role of ADMIN_ROLES) {
        expect(can(action, { ...accessBase, viewerRole: role })).toBe(false);
      }
      expect(can(action, { ...accessBase, isOwner: true })).toBe(true);
    }
  });

  it("lets a platform admin delete a community without membership", () => {
    for (const role of ADMIN_ROLES) {
      expect(can("delete_community", { ...accessBase, viewerRole: role })).toBe(true);
    }
  });

  it("refuses posting to a platform admin who is not a member (decision J4)", () => {
    // Posting is participation, not moderation.
    for (const role of ADMIN_ROLES) {
      expect(can("create_post", { ...accessBase, viewerRole: role })).toBe(false);
    }
    expect(can("create_post", { ...accessBase, memberRole: "member" })).toBe(true);
  });

  it("gives a moderator events but not rules", () => {
    expect(can("manage_events", { ...accessBase, memberRole: "moderator" })).toBe(true);
    expect(can("manage_rules", { ...accessBase, memberRole: "moderator" })).toBe(false);
    expect(can("manage_rules", { ...accessBase, memberRole: "admin" })).toBe(true);
  });

  it("never lets `guest` satisfy the admin bypass", () => {
    for (const action of ALL_ACTIONS) {
      expect(can(action, { ...accessBase, viewerRole: "guest" })).toBe(false);
    }
  });
});

describe("Member management ranking", () => {
  it("lets an admin act on moderators and members but not on the owner", () => {
    const admin = { ...accessBase, memberRole: "admin" as CommunityRole };
    expect(canManageMemberAt("moderator", admin)).toBe(true);
    expect(canManageMemberAt("member", admin)).toBe(true);
    expect(canManageMemberAt("owner", admin)).toBe(false);
  });

  it("stops two admins from removing each other", () => {
    const admin = { ...accessBase, memberRole: "admin" as CommunityRole };
    expect(canManageMemberAt("admin", admin)).toBe(false);
  });

  it("stops a moderator from managing anyone at all", () => {
    // `moderator` holds no `manage_members` grant.
    const moderator = { ...accessBase, memberRole: "moderator" as CommunityRole };
    for (const role of ALL_COMMUNITY_ROLES) {
      expect(canManageMemberAt(role, moderator)).toBe(false);
    }
  });

  it("lets the owner of record manage every role except the owner row", () => {
    const owner = { ...accessBase, isOwner: true };
    expect(canManageMemberAt("admin", owner)).toBe(true);
    expect(canManageMemberAt("moderator", owner)).toBe(true);
    expect(canManageMemberAt("member", owner)).toBe(true);
    // Ownership moves only through the audited transfer (decision J7).
    expect(canManageMemberAt("owner", owner)).toBe(false);
  });

  it("lets a platform admin with no membership manage every non-owner role", () => {
    for (const role of ADMIN_ROLES) {
      const platformAdmin = { ...accessBase, viewerRole: role };
      expect(canManageMemberAt("admin", platformAdmin)).toBe(true);
      expect(canManageMemberAt("member", platformAdmin)).toBe(true);
      expect(canManageMemberAt("owner", platformAdmin)).toBe(false);
    }
  });
});

describe("Role assignment", () => {
  it("never assigns `owner` through the member routes", () => {
    expect(canAssignRole("owner", { ...accessBase, isOwner: true })).toBe(false);
    for (const role of ADMIN_ROLES) {
      expect(canAssignRole("owner", { ...accessBase, viewerRole: role })).toBe(false);
    }
  });

  it("keeps promoting to `admin` an owner-only act", () => {
    expect(canAssignRole("admin", { ...accessBase, isOwner: true })).toBe(true);
    expect(canAssignRole("admin", { ...accessBase, memberRole: "admin" })).toBe(false);
  });

  it("lets an admin assign moderator and member", () => {
    const admin = { ...accessBase, memberRole: "admin" as CommunityRole };
    expect(canAssignRole("moderator", admin)).toBe(true);
    expect(canAssignRole("member", admin)).toBe(true);
  });

  it("excludes `owner` from the assignable set", () => {
    expect(ASSIGNABLE_COMMUNITY_ROLES).not.toContain("owner");
    expect([...ASSIGNABLE_COMMUNITY_ROLES].sort()).toEqual([
      "admin",
      "member",
      "moderator",
    ]);
  });

  it("counts owner, admin, and moderator as moderating roles", () => {
    expect([...MODERATING_ROLES].sort()).toEqual(["admin", "moderator", "owner"]);
    expect(MODERATING_ROLES).not.toContain("member");
  });
});

describe("Post removal", () => {
  it("lets an author remove their own post without a moderation grant", () => {
    expect(canRemovePost({ ...accessBase, memberRole: "member", isAuthor: true })).toBe(
      true,
    );
  });

  it("refuses a plain member removing someone else's post", () => {
    expect(canRemovePost({ ...accessBase, memberRole: "member", isAuthor: false })).toBe(
      false,
    );
  });

  it("lets a moderator remove another member's post", () => {
    expect(
      canRemovePost({ ...accessBase, memberRole: "moderator", isAuthor: false }),
    ).toBe(true);
  });
});

/* ══ Schemas ══════════════════════════════════════════════════════════════ */

describe("Community create validation", () => {
  it("accepts a minimal name + category body", () => {
    const result = createCommunitySchema.safeParse({
      name: "AI Tooling",
      category: "Artificial Intelligence",
    });
    expect(result.success).toBe(true);
  });

  it("requires a category, since discovery is browsed by category tabs", () => {
    expect(createCommunitySchema.safeParse({ name: "AI Tooling" }).success).toBe(false);
  });

  it("rejects a blank or whitespace-only category (decision J9)", () => {
    for (const category of ["", "   "]) {
      expect(
        createCommunitySchema.safeParse({ name: "Valid Name", category }).success,
      ).toBe(false);
    }
  });

  it("accepts any bounded category string rather than an enum (decision J9)", () => {
    // The seed ships these, and the UI derives its tabs from whatever exists.
    for (const category of ["Artificial Intelligence", "Design", "Startups", "Ops"]) {
      expect(
        createCommunitySchema.safeParse({ name: "Valid Name", category }).success,
      ).toBe(true);
    }
  });

  it("caps the category length", () => {
    expect(
      createCommunitySchema.safeParse({ name: "Valid Name", category: "x".repeat(61) })
        .success,
    ).toBe(false);
  });

  it("trims the name and rejects one that is too short", () => {
    const parsed = createCommunitySchema.parse({
      name: "  AI Tooling  ",
      category: "Design",
    });
    expect(parsed.name).toBe("AI Tooling");
    expect(
      createCommunitySchema.safeParse({ name: "A", category: "Design" }).success,
    ).toBe(false);
  });

  it("strips slug, ownerId, and memberCount rather than trusting them", () => {
    const parsed = createCommunitySchema.parse({
      name: "AI Tooling",
      category: "Design",
      slug: "attacker-chosen",
      ownerId: "00000000-0000-4000-8000-000000000000",
      memberCount: 9_999,
    });
    expect(parsed).not.toHaveProperty("slug");
    expect(parsed).not.toHaveProperty("ownerId");
    expect(parsed).not.toHaveProperty("memberCount");
  });

  it("caps the tag list at ten", () => {
    const tags = Array.from({ length: 11 }, (_, i) => `tag-${String(i)}`);
    expect(
      createCommunitySchema.safeParse({ name: "Valid Name", category: "Design", tags })
        .success,
    ).toBe(false);
  });
});

describe("Community update validation", () => {
  it("rejects an empty patch rather than performing a no-op write", () => {
    expect(updateCommunitySchema.safeParse({}).success).toBe(false);
  });

  it("accepts a single-field patch", () => {
    expect(updateCommunitySchema.safeParse({ description: "Updated" }).success).toBe(
      true,
    );
  });

  it("offers no way to change the slug", () => {
    const parsed = updateCommunitySchema.parse({
      name: "Renamed",
      slug: "renamed-by-client",
    });
    expect(parsed).not.toHaveProperty("slug");
  });
});

describe("Rules validation (decision J11)", () => {
  it("accepts an ordered replace-set", () => {
    const parsed = replaceRulesSchema.parse({ rules: ["Be kind", "Stay on topic"] });
    expect(parsed.rules).toEqual(["Be kind", "Stay on topic"]);
  });

  it("accepts an empty array as a deliberate clear", () => {
    expect(replaceRulesSchema.safeParse({ rules: [] }).success).toBe(true);
  });

  it("rejects an empty or whitespace-only rule", () => {
    expect(replaceRulesSchema.safeParse({ rules: ["Fine", "   "] }).success).toBe(false);
  });

  it("caps the rule count and each rule's length", () => {
    expect(
      replaceRulesSchema.safeParse({ rules: Array.from({ length: 31 }, () => "Rule") })
        .success,
    ).toBe(false);
    expect(replaceRulesSchema.safeParse({ rules: ["x".repeat(501)] }).success).toBe(
      false,
    );
  });
});

describe("Event validation (decision J10)", () => {
  it("accepts a title plus a start time", () => {
    const result = createEventSchema.safeParse({
      title: "Office hours",
      startsAt: "2026-09-01T17:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an end that precedes the start", () => {
    const result = createEventSchema.safeParse({
      title: "Office hours",
      startsAt: "2026-09-01T17:00:00.000Z",
      endsAt: "2026-09-01T16:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("accepts an end equal to the start", () => {
    const at = "2026-09-01T17:00:00.000Z";
    expect(
      createEventSchema.safeParse({ title: "Instant", startsAt: at, endsAt: at }).success,
    ).toBe(true);
  });

  it("accepts a null end for an open-ended event", () => {
    expect(
      createEventSchema.safeParse({
        title: "Ongoing",
        startsAt: "2026-09-01T17:00:00.000Z",
        endsAt: null,
      }).success,
    ).toBe(true);
  });

  it("never accepts attendeeCount, which no write path can maintain", () => {
    const parsed = createEventSchema.parse({
      title: "Office hours",
      startsAt: "2026-09-01T17:00:00.000Z",
      attendeeCount: 500,
    });
    expect(parsed).not.toHaveProperty("attendeeCount");
  });

  it("rejects an empty event patch", () => {
    expect(updateEventSchema.safeParse({}).success).toBe(false);
  });

  it("still enforces the ordering on a patch that carries both ends", () => {
    expect(
      updateEventSchema.safeParse({
        startsAt: "2026-09-01T17:00:00.000Z",
        endsAt: "2026-09-01T09:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("permits a patch that moves only the start, deferring to the service", () => {
    expect(
      updateEventSchema.safeParse({ startsAt: "2026-09-01T17:00:00.000Z" }).success,
    ).toBe(true);
  });
});

describe("Member and ownership validation", () => {
  it("accepts the three assignable roles and refuses `owner`", () => {
    for (const role of ASSIGNABLE_COMMUNITY_ROLES) {
      expect(memberRoleSchema.safeParse({ role }).success).toBe(true);
    }
    expect(memberRoleSchema.safeParse({ role: "owner" }).success).toBe(false);
  });

  it("lower-cases a username on the way in", () => {
    expect(addMemberSchema.parse({ username: "Ava.Codes" }).username).toBe("ava.codes");
    expect(transferOwnershipSchema.parse({ username: "Ava.Codes" }).username).toBe(
      "ava.codes",
    );
  });

  it("rejects a username outside the Phase 4 charset", () => {
    expect(addMemberSchema.safeParse({ username: "has-hyphen" }).success).toBe(false);
  });
});

describe("Pin validation (decision J14)", () => {
  it("requires a uuid post id", () => {
    expect(
      pinPostSchema.safeParse({ postId: "00000000-0000-4000-8000-000000000000" }).success,
    ).toBe(true);
    expect(pinPostSchema.safeParse({ postId: "not-a-uuid" }).success).toBe(false);
  });
});

describe("Identifier and listing validation", () => {
  it("accepts a slugified slug and rejects one `slugify` could not produce", () => {
    expect(communitySlugParamSchema.safeParse({ slug: "ai-tooling" }).success).toBe(true);
    for (const slug of ["AI-Tooling", "ai tooling", "ai_tooling", ""]) {
      expect(communitySlugParamSchema.safeParse({ slug }).success).toBe(false);
    }
  });

  it("defaults the discovery query and coerces its limit", () => {
    const parsed = communityListQuerySchema.parse({});
    expect(parsed.limit).toBe(20);
    expect(parsed.sort).toBe("recent");
    expect(parsed.cursor).toBeUndefined();
    expect(communityListQuerySchema.parse({ limit: "5" }).limit).toBe(5);
  });

  it("refuses a limit above the shared page cap", () => {
    expect(communityListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  it("accepts only indexed sort keys", () => {
    for (const sort of COMMUNITY_SORTS) {
      expect(communityListQuerySchema.safeParse({ sort }).success).toBe(true);
    }
    expect(communityListQuerySchema.safeParse({ sort: "alphabetical" }).success).toBe(
      false,
    );
  });

  it("carries the optional category and search filters (decision J12)", () => {
    const parsed = communityListQuerySchema.parse({ category: "Design", q: "systems" });
    expect(parsed.category).toBe("Design");
    expect(parsed.q).toBe("systems");
  });
});
