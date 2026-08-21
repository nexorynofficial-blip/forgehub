import { describe, expect, it } from "vitest";

import {
  can,
  canModifyUpdate,
  ROLE_PERMISSIONS,
  type ProjectAccessContext,
  type ProjectAction,
} from "../src/modules/projects/project.access.js";
import {
  isProjectListable,
  resolveProjectVisibility,
  type ProjectVisibilityContext,
} from "../src/modules/projects/project.visibility.js";
import {
  addMemberSchema,
  createMilestoneSchema,
  createProjectSchema,
  projectListQuerySchema,
  PROJECT_SORTS,
  slugParamSchema,
  updateMemberRoleSchema,
  updateMilestoneSchema,
  updateProjectSchema,
} from "../src/modules/projects/projects.schema.js";
import {
  initialSlugFor,
  isReservedSlug,
  MAX_SLUG_LENGTH,
  slugCandidate,
  slugify,
} from "../src/utils/slug.js";

/**
 * Unit coverage for the pure rules behind Phase 5.
 *
 * Visibility and permissions decide whether project data leaves the server and
 * who may rewrite it, so they are written as pure functions and tested without
 * a database, a session, or an HTTP request — every branch is reachable
 * directly, including the combinations that are awkward to stage end to end.
 */

/* ── Slugs (decision J2) ─────────────────────────────────────────────────── */

describe("Slugify", () => {
  it("derives the seeded slugs from their titles", () => {
    // The seed's four projects, as a regression anchor against real data.
    expect(slugify("Coastline CRM")).toBe("coastline-crm");
    expect(slugify("Tidal Notes")).toBe("tidal-notes");
    expect(slugify("Pixelforge")).toBe("pixelforge");
    expect(slugify("Forge Components")).toBe("forge-components");
  });

  it("lowercases, so a slug is a stable URL regardless of title casing", () => {
    expect(slugify("FORGE Components")).toBe("forge-components");
  });

  it("strips diacritics rather than dropping the letters carrying them", () => {
    // NFKD decomposition separates the accent into a combining mark, which is
    // removed — leaving `cafe`, not `caf`.
    expect(slugify("Café Résumé")).toBe("cafe-resume");
  });

  it("collapses runs of punctuation and whitespace into single hyphens", () => {
    expect(slugify("My   Cool -- Project!!!")).toBe("my-cool-project");
  });

  it("never leaves a leading or trailing hyphen", () => {
    expect(slugify("  ...Hello...  ")).toBe("hello");
    expect(slugify("!!!")).not.toMatch(/^-|-$/);
  });

  it("falls back rather than producing an empty slug", () => {
    // A title of only emoji or punctuation is valid content but slugifies to
    // nothing; an empty slug would be an unroutable URL.
    expect(slugify("🎉🎉🎉")).toBe("project");
    expect(slugify("")).toBe("project");
    expect(slugify("---")).toBe("project");
  });

  it("truncates to the maximum length without a trailing hyphen", () => {
    const slug = slugify(`${"word ".repeat(40)}end`);

    expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(slug).not.toMatch(/-$/);
  });
});

describe("Slug candidates", () => {
  it("returns the base unchanged for the first attempt", () => {
    expect(slugCandidate("forge-components", 0)).toBe("forge-components");
  });

  it("suffixes from 2 upward, matching how a human would number duplicates", () => {
    expect(slugCandidate("forge-components", 1)).toBe("forge-components-2");
    expect(slugCandidate("forge-components", 2)).toBe("forge-components-3");
  });

  it("shortens the base rather than the suffix when space runs out", () => {
    // The suffix is the part that makes the slug unique, so it must survive
    // truncation — otherwise every candidate would collapse back to the base.
    const long = "a".repeat(MAX_SLUG_LENGTH);
    const candidate = slugCandidate(long, 1);

    expect(candidate.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(candidate).toMatch(/-2$/);
  });
});

describe("Reserved slugs", () => {
  it("reserves handles that would shadow a route under /projects", () => {
    // `/projects/trending` is declared before `/projects/:slug`, and
    // `/projects/new` is already linked from the shipped sidebar.
    for (const value of ["new", "trending", "me", "api", "admin"]) {
      expect(isReservedSlug(value)).toBe(true);
    }
  });

  it("steps a reserved title past the reservation instead of rejecting it", () => {
    // The user named their project; refusing the title over an internal
    // routing detail would be a strange form error to explain.
    expect(initialSlugFor("New")).toBe("new-2");
    expect(initialSlugFor("Trending")).toBe("trending-2");
  });

  it("leaves an ordinary title alone", () => {
    expect(initialSlugFor("Coastline CRM")).toBe("coastline-crm");
  });
});

/* ── Visibility (decisions J5 + PRD §6) ──────────────────────────────────── */

const baseVisibility: ProjectVisibilityContext = {
  viewerId: "viewer-1",
  viewerRole: "member",
  ownerId: "owner-1",
  visibility: "public",
  deleted: false,
  isMember: false,
  ownerBlockedViewer: false,
};

describe("Project visibility", () => {
  it("shows a public project to anyone, including anonymous callers", () => {
    expect(resolveProjectVisibility(baseVisibility)).toBe("full");
    expect(
      resolveProjectVisibility({
        ...baseVisibility,
        viewerId: null,
        viewerRole: null,
      }),
    ).toBe("full");
  });

  it("hides a private project from an unrelated viewer as not_found", () => {
    // 404 rather than 403: a 403 would confirm the project exists.
    expect(resolveProjectVisibility({ ...baseVisibility, visibility: "private" })).toBe(
      "not_found",
    );
  });

  it("shows a private project to its owner", () => {
    expect(
      resolveProjectVisibility({
        ...baseVisibility,
        viewerId: "owner-1",
        visibility: "private",
      }),
    ).toBe("full");
  });

  it("shows a private project to a member", () => {
    expect(
      resolveProjectVisibility({
        ...baseVisibility,
        visibility: "private",
        isMember: true,
      }),
    ).toBe("full");
  });

  it("lets each admin role through a private project", () => {
    for (const role of ["moderator", "community_admin", "platform_admin"] as const) {
      expect(
        resolveProjectVisibility({
          ...baseVisibility,
          viewerRole: role,
          visibility: "private",
        }),
      ).toBe("full");
    }
  });

  it("never treats the frontend's `guest` sentinel as an admin", () => {
    expect(
      resolveProjectVisibility({
        ...baseVisibility,
        viewerRole: "guest",
        visibility: "private",
      }),
    ).toBe("not_found");
  });

  it("reads an unlisted project directly but keeps it out of listings", () => {
    // This split is the whole distinction PRD §6 draws between `unlisted` and
    // `private`: unlisted means "not enumerable", not "not readable".
    const unlisted = { ...baseVisibility, visibility: "unlisted" as const };

    expect(resolveProjectVisibility(unlisted)).toBe("full");
    expect(isProjectListable(unlisted)).toBe(false);
  });

  it("resolves a soft-deleted project to not_found for everyone", () => {
    for (const context of [
      { ...baseVisibility, deleted: true },
      { ...baseVisibility, deleted: true, viewerId: "owner-1" },
      { ...baseVisibility, deleted: true, viewerRole: "platform_admin" as const },
    ]) {
      expect(resolveProjectVisibility(context)).toBe("not_found");
      expect(isProjectListable(context)).toBe(false);
    }
  });

  it("resolves a block to not_found, outranking every other rule", () => {
    // Decision J5, carrying forward the Phase 4 precedent: blocking outranks
    // even the admin role, because a 403 would announce the block.
    const blocked = { ...baseVisibility, ownerBlockedViewer: true };

    expect(resolveProjectVisibility(blocked)).toBe("not_found");
    expect(resolveProjectVisibility({ ...blocked, isMember: true })).toBe("not_found");
    expect(resolveProjectVisibility({ ...blocked, viewerRole: "platform_admin" })).toBe(
      "not_found",
    );
    expect(isProjectListable({ ...blocked, viewerRole: "platform_admin" })).toBe(false);
  });
});

describe("Project listability", () => {
  it("includes a public project for anyone", () => {
    expect(isProjectListable(baseVisibility)).toBe(true);
    expect(
      isProjectListable({ ...baseVisibility, viewerId: null, viewerRole: null }),
    ).toBe(true);
  });

  it("omits a private project from an unrelated viewer's listing", () => {
    expect(isProjectListable({ ...baseVisibility, visibility: "private" })).toBe(false);
  });

  it("keeps an owner's own private and unlisted projects in their listing", () => {
    // For the owner these are not hidden content — they are their content.
    for (const visibility of ["private", "unlisted"] as const) {
      expect(
        isProjectListable({ ...baseVisibility, viewerId: "owner-1", visibility }),
      ).toBe(true);
    }
  });
});

/* ── Permissions (ARCHITECTURE §18, decision J8) ─────────────────────────── */

const baseAccess: ProjectAccessContext = {
  isOwner: false,
  memberRole: null,
  viewerRole: "member",
};

const ALL_ACTIONS: ProjectAction[] = [
  "edit_project",
  "delete_project",
  "transfer_ownership",
  "manage_members",
  "assign_owner_role",
  "manage_milestones",
  "create_update",
  "moderate_updates",
];

describe("Project permissions", () => {
  it("grants the owner of record every action", () => {
    for (const action of ALL_ACTIONS) {
      expect(can(action, { ...baseAccess, isOwner: true })).toBe(true);
    }
  });

  it("grants a non-member nothing", () => {
    for (const action of ALL_ACTIONS) {
      expect(can(action, baseAccess)).toBe(false);
    }
  });

  it("grants an anonymous caller nothing", () => {
    for (const action of ALL_ACTIONS) {
      expect(can(action, { isOwner: false, memberRole: null, viewerRole: null })).toBe(
        false,
      );
    }
  });

  it("lets a contributor post an update and nothing more", () => {
    const contributor = { ...baseAccess, memberRole: "contributor" as const };

    expect(can("create_update", contributor)).toBe(true);
    for (const action of ALL_ACTIONS.filter((a) => a !== "create_update")) {
      expect(can(action, contributor)).toBe(false);
    }
  });

  it("lets a collaborator manage milestones but not members", () => {
    const collaborator = { ...baseAccess, memberRole: "collaborator" as const };

    expect(can("manage_milestones", collaborator)).toBe(true);
    expect(can("create_update", collaborator)).toBe(true);
    expect(can("manage_members", collaborator)).toBe(false);
    expect(can("edit_project", collaborator)).toBe(false);
  });

  it("lets a project admin manage members but not delete the project", () => {
    const admin = { ...baseAccess, memberRole: "admin" as const };

    expect(can("manage_members", admin)).toBe(true);
    expect(can("edit_project", admin)).toBe(true);
    expect(can("delete_project", admin)).toBe(false);
  });

  it("reserves ownership transfer and owner-role assignment to the owner alone", () => {
    // Not a project `admin`, and not a platform admin: reassigning someone's
    // project is a moderation action, and moderation is a Phase 11 surface.
    for (const action of ["transfer_ownership", "assign_owner_role"] as const) {
      expect(can(action, { ...baseAccess, memberRole: "admin" })).toBe(false);
      expect(can(action, { ...baseAccess, viewerRole: "platform_admin" })).toBe(false);
      expect(can(action, { ...baseAccess, isOwner: true })).toBe(true);
    }
  });

  it("lets each platform admin role edit and delete without membership", () => {
    for (const role of ["moderator", "community_admin", "platform_admin"] as const) {
      expect(can("edit_project", { ...baseAccess, viewerRole: role })).toBe(true);
      expect(can("delete_project", { ...baseAccess, viewerRole: role })).toBe(true);
    }
  });

  it("never treats `guest` as an admin", () => {
    expect(can("edit_project", { ...baseAccess, viewerRole: "guest" })).toBe(false);
  });

  it("keeps every one of the six persisted roles in the permission table", () => {
    // Decision J4 narrows what may be *assigned*, not what may be *stored* —
    // the seed already persists `developer`, and a role missing from this table
    // would throw on any permission check for that member.
    for (const role of [
      "owner",
      "admin",
      "developer",
      "designer",
      "collaborator",
      "contributor",
    ] as const) {
      expect(ROLE_PERMISSIONS[role]).toBeDefined();
      expect(can("create_update", { ...baseAccess, memberRole: role })).toBe(true);
    }
  });
});

describe("Update modification", () => {
  it("lets an author edit their own update whatever their role", () => {
    // A contributor holds no `moderate_updates` grant but must still be able to
    // fix their own typo — which is why authorship is a separate check.
    expect(
      canModifyUpdate({ ...baseAccess, memberRole: "contributor", isAuthor: true }),
    ).toBe(true);
  });

  it("stops a contributor editing someone else's update", () => {
    expect(
      canModifyUpdate({ ...baseAccess, memberRole: "contributor", isAuthor: false }),
    ).toBe(false);
  });

  it("lets the owner and project admins moderate any update", () => {
    expect(canModifyUpdate({ ...baseAccess, isOwner: true, isAuthor: false })).toBe(true);
    expect(canModifyUpdate({ ...baseAccess, memberRole: "admin", isAuthor: false })).toBe(
      true,
    );
  });
});

/* ── Validation (TRD §15) ────────────────────────────────────────────────── */

describe("Project create validation", () => {
  it("accepts a title alone, so the details can follow", () => {
    const result = createProjectSchema.safeParse({ title: "Coastline CRM" });
    expect(result.success).toBe(true);
  });

  it("accepts the full BACKEND_PRD §6 field set", () => {
    const result = createProjectSchema.safeParse({
      title: "Forge Components",
      description: "An accessible React component library.",
      techStack: ["React", "Tailwind"],
      tags: ["Open Source", "Design Systems"],
      status: "in_progress",
      fundingStage: "not_seeking",
      visibility: "unlisted",
      demoUrl: "https://example.com",
      repositoryUrl: "https://github.com/x/y",
      gallery: ["gal_1", "gal_2"],
    });

    expect(result.success).toBe(true);
  });

  it("requires a usable title", () => {
    expect(createProjectSchema.safeParse({}).success).toBe(false);
    expect(createProjectSchema.safeParse({ title: "a" }).success).toBe(false);
    expect(createProjectSchema.safeParse({ title: "x".repeat(121) }).success).toBe(false);
  });

  it("strips every server-owned field rather than honouring it", () => {
    // The whole reason these are absent from the schema: a client that posts
    // them is not rejected, the values simply never reach a repository.
    const parsed = createProjectSchema.parse({
      title: "Sneaky",
      slug: "chosen-by-client",
      ownerId: "00000000-0000-0000-0000-000000000000",
      progressPercent: 100,
      viewsCount: 999_999,
      likesCount: 999_999,
      followersCount: 999_999,
      createdAt: "2020-01-01T00:00:00.000Z",
      deletedAt: null,
    } as never);

    for (const key of [
      "slug",
      "ownerId",
      "progressPercent",
      "viewsCount",
      "likesCount",
      "followersCount",
      "createdAt",
      "deletedAt",
    ]) {
      expect(parsed).not.toHaveProperty(key);
    }
    expect(parsed.title).toBe("Sneaky");
  });

  it("accepts the shipped fixtures' opaque gallery ids (decision J10)", () => {
    // `mock/projects.ts` stores "gal_1"; URL validation would reject the
    // project's own seed data.
    expect(
      createProjectSchema.safeParse({ title: "Ok", gallery: ["gal_1"] }).success,
    ).toBe(true);
  });

  it("bounds the gallery so a String[] cannot become a payload vector", () => {
    expect(
      createProjectSchema.safeParse({
        title: "Ok",
        gallery: Array.from({ length: 21 }, (_, i) => `gal_${String(i)}`),
      }).success,
    ).toBe(false);
    expect(
      createProjectSchema.safeParse({ title: "Ok", gallery: ["x".repeat(501)] }).success,
    ).toBe(false);
  });

  it("caps tags and tech stack", () => {
    expect(
      createProjectSchema.safeParse({
        title: "Ok",
        tags: Array.from({ length: 11 }, (_, i) => `tag${String(i)}`),
      }).success,
    ).toBe(false);
    expect(
      createProjectSchema.safeParse({
        title: "Ok",
        techStack: Array.from({ length: 31 }, (_, i) => `tech${String(i)}`),
      }).success,
    ).toBe(false);
  });

  it("validates the three external links as real URLs", () => {
    expect(
      createProjectSchema.safeParse({ title: "Ok", demoUrl: "not-a-url" }).success,
    ).toBe(false);
    expect(
      createProjectSchema.safeParse({ title: "Ok", repositoryUrl: "javascript:alert(1)" })
        .success,
    ).toBe(false);
  });

  it("normalizes an empty link to null rather than an empty string", () => {
    const parsed = createProjectSchema.parse({ title: "Ok", demoUrl: "" });
    expect(parsed.demoUrl).toBeNull();
  });

  it("rejects values outside the persisted enums", () => {
    expect(
      createProjectSchema.safeParse({ title: "Ok", status: "shipped" }).success,
    ).toBe(false);
    expect(
      createProjectSchema.safeParse({ title: "Ok", visibility: "followers" }).success,
    ).toBe(false);
    expect(
      createProjectSchema.safeParse({ title: "Ok", fundingStage: "series_z" }).success,
    ).toBe(false);
  });
});

describe("Project update validation", () => {
  it("rejects an empty patch rather than performing a no-op write", () => {
    expect(updateProjectSchema.safeParse({}).success).toBe(false);
  });

  it("refuses to let a patch become a back door into the counters", () => {
    const parsed = updateProjectSchema.parse({
      title: "Renamed",
      progressPercent: 100,
      likesCount: 5_000,
      viewsCount: 5_000,
      ownerId: "00000000-0000-0000-0000-000000000000",
      slug: "new-slug",
    } as never);

    expect(parsed).toEqual({ title: "Renamed" });
  });

  it("does not accept a slug change (decision J2)", () => {
    // Renaming would break every existing link, and Phase 5 has no redirects.
    expect(updateProjectSchema.safeParse({ slug: "renamed" }).success).toBe(false);
  });
});

describe("Member role validation (decision J4)", () => {
  it("accepts the three roles the shipped UI can label", () => {
    for (const role of ["owner", "collaborator", "contributor"]) {
      expect(addMemberSchema.safeParse({ username: "ava", role }).success).toBe(true);
    }
  });

  it("refuses to assign the three roles the shipped UI cannot label", () => {
    // `project-team.tsx` maps exactly three; the others would render an empty
    // badge. Reads still return them verbatim — this bounds writes only.
    for (const role of ["admin", "developer", "designer"]) {
      expect(addMemberSchema.safeParse({ username: "ava", role }).success).toBe(false);
      expect(updateMemberRoleSchema.safeParse({ role }).success).toBe(false);
    }
  });

  it("defaults a new member to contributor", () => {
    const parsed = addMemberSchema.parse({ username: "ava" });
    expect(parsed.role).toBe("contributor");
  });

  it("lowercases the target handle, as usernames are stored lowercase", () => {
    expect(addMemberSchema.parse({ username: "AvA.CoDeS" }).username).toBe("ava.codes");
  });
});

describe("Milestone validation", () => {
  it("accepts a milestone and rejects an empty patch", () => {
    expect(createMilestoneSchema.safeParse({ title: "Public beta" }).success).toBe(true);
    expect(updateMilestoneSchema.safeParse({}).success).toBe(false);
  });

  it("never accepts progressPercent (decision J3)", () => {
    // It is derived from these rows, so accepting it would let a client assert
    // a figure its own milestones contradict.
    const parsed = updateMilestoneSchema.parse({
      isComplete: true,
      progressPercent: 100,
    } as never);

    expect(parsed).not.toHaveProperty("progressPercent");
  });

  it("accepts a null target date and coerces an ISO string", () => {
    expect(
      createMilestoneSchema.parse({ title: "Later", targetDate: null }).targetDate,
    ).toBeNull();
    expect(
      createMilestoneSchema.parse({
        title: "Soon",
        targetDate: "2026-06-01T00:00:00.000Z",
      }).targetDate,
    ).toBeInstanceOf(Date);
  });
});

describe("Query validation", () => {
  it("defaults page, limit, and sort", () => {
    const parsed = projectListQuerySchema.parse({});
    expect(parsed).toMatchObject({ page: 1, limit: 20, sort: "recent" });
  });

  it("restricts sort to indexed columns", () => {
    // An open sort parameter would let a caller order by an unindexed column
    // and turn discovery into a sequential scan.
    for (const sort of PROJECT_SORTS) {
      expect(projectListQuerySchema.safeParse({ sort }).success).toBe(true);
    }
    expect(projectListQuerySchema.safeParse({ sort: "views" }).success).toBe(false);
    expect(projectListQuerySchema.safeParse({ sort: "id; DROP TABLE" }).success).toBe(
      false,
    );
  });

  it("caps the page size at the shared maximum", () => {
    expect(projectListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(projectListQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(projectListQuerySchema.safeParse({ limit: 100 }).success).toBe(true);
  });
});

describe("Slug parameter validation", () => {
  it("accepts what slugify produces", () => {
    expect(slugParamSchema.safeParse({ slug: "forge-components-2" }).success).toBe(true);
  });

  it("rejects anything slugify would never emit", () => {
    // A malformed slug becomes a 422 rather than a database round trip.
    for (const slug of ["Forge_Components", "has space", "../etc", "UPPER", "emoji🎉"]) {
      expect(slugParamSchema.safeParse({ slug }).success).toBe(false);
    }
  });

  it("accepts no UUID fallback (decision J2)", () => {
    expect(
      slugParamSchema.safeParse({ slug: "3f1e4c2a-0b6d-4e8f-9a1b-2c3d4e5f6071" }).success,
    ).toBe(true);
    // Hyphenated lowercase hex is a legal *slug*; the repository still looks it
    // up by the slug column only, so no id lookup happens.
  });
});
