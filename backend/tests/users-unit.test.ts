import { describe, expect, it } from "vitest";

import {
  calculateProfileCompletion,
  type ProfileCompletionInput,
} from "../src/modules/users/user.view.js";
import {
  updateProfileSchema,
  updateSettingsSchema,
  usernameSchema,
} from "../src/modules/users/users.schema.js";
import {
  canSeeEmail,
  resolveVisibility,
  type VisibilityContext,
} from "../src/modules/users/visibility.js";

/**
 * Unit coverage for the pure rules behind Phase 4.
 *
 * Visibility and email exposure decide whether private data leaves the
 * server, so they are written as pure functions and tested without a
 * database, a session, or an HTTP request — every branch is reachable
 * directly, including the combinations that are awkward to stage end to end.
 */

const baseVisibility: VisibilityContext = {
  viewerId: "viewer-1",
  viewerRole: "member",
  targetId: "target-1",
  targetVisibility: "public",
  isFollowing: false,
  targetBlockedViewer: false,
};

describe("Username validation", () => {
  it("accepts the shapes the shipped account form accepts", () => {
    for (const value of ["ava.codes", "grace_hopper", "user123", "a_b.c"]) {
      expect(usernameSchema.parse(value)).toBe(value.toLowerCase());
    }
  });

  it("lowercases so the unique index is effectively case-insensitive", () => {
    // Postgres comparison is case-sensitive; without this "Ava" and "ava"
    // would be two accounts resolving to two different profile URLs.
    expect(usernameSchema.parse("AvA.CoDeS")).toBe("ava.codes");
  });

  it("rejects anything outside the frontend's character set", () => {
    for (const value of ["has space", "hyphen-ated", "emoji🎉", "at@sign", "sl/ash"]) {
      expect(usernameSchema.safeParse(value).success).toBe(false);
    }
  });

  it("enforces the frontend's length rules", () => {
    expect(usernameSchema.safeParse("ab").success).toBe(false);
    expect(usernameSchema.safeParse("abc").success).toBe(true);
    expect(usernameSchema.safeParse("a".repeat(31)).success).toBe(false);
  });

  it("rejects reserved handles that would shadow a route", () => {
    // `/users/me` and `/users/:username` share a prefix.
    for (const value of ["me", "admin", "api", "settings", "null"]) {
      expect(usernameSchema.safeParse(value).success).toBe(false);
    }
  });

  it("rejects handles with no alphanumeric character at all", () => {
    // In-charset but unusable as an identifier, and looks like a broken URL.
    expect(usernameSchema.safeParse("...").success).toBe(false);
    expect(usernameSchema.safeParse("___").success).toBe(false);
    expect(usernameSchema.safeParse("._.").success).toBe(false);
  });
});

describe("Profile update validation", () => {
  it("accepts the shipped Settings → Account payload shape", () => {
    const result = updateProfileSchema.safeParse({
      displayName: "Ada Lovelace",
      username: "ada.lovelace",
      email: "ada@example.com",
      bio: "Building things.",
      experienceYears: 6,
      skills: ["TypeScript", "Systems"],
      techStack: ["Node.js"],
      socialLinks: [{ platform: "github", url: "https://github.com/ada" }],
    });

    expect(result.success).toBe(true);
  });

  it("rejects an empty patch rather than performing a no-op write", () => {
    expect(updateProfileSchema.safeParse({}).success).toBe(false);
  });

  it("enforces the frontend's bio and experience limits", () => {
    expect(updateProfileSchema.safeParse({ bio: "x".repeat(281) }).success).toBe(false);
    expect(updateProfileSchema.safeParse({ experienceYears: 61 }).success).toBe(false);
    expect(updateProfileSchema.safeParse({ experienceYears: -1 }).success).toBe(false);
    expect(updateProfileSchema.safeParse({ experienceYears: null }).success).toBe(true);
  });

  it("rejects duplicate social platforms", () => {
    // `@@unique([profileId, platform])` would reject this at the database
    // level; catching it here turns a 500 into a field-level 422.
    const result = updateProfileSchema.safeParse({
      socialLinks: [
        { platform: "github", url: "https://github.com/a" },
        { platform: "github", url: "https://github.com/b" },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects a malformed social link URL", () => {
    expect(
      updateProfileSchema.safeParse({
        socialLinks: [{ platform: "github", url: "not-a-url" }],
      }).success,
    ).toBe(false);
  });

  it("normalizes an empty website to null rather than an empty string", () => {
    const result = updateProfileSchema.parse({ websiteUrl: "" });
    expect(result.websiteUrl).toBeNull();
  });
});

describe("Settings validation", () => {
  it("accepts the frontend's PrivacySettings values", () => {
    expect(
      updateSettingsSchema.safeParse({
        profileVisibility: "followers",
        showEmailOnProfile: true,
        whoCanMessage: "followers",
      }).success,
    ).toBe(true);
  });

  it("refuses twoFactorEnabled as a writable setting", () => {
    // Enabling 2FA must go through enrollment with a verified TOTP code;
    // accepting it here would let a client claim it without proving it.
    const result = updateSettingsSchema.parse({
      showEmailOnProfile: true,
      twoFactorEnabled: true,
    } as never);

    expect(result).not.toHaveProperty("twoFactorEnabled");
  });

  it("rejects an unknown visibility value", () => {
    expect(updateSettingsSchema.safeParse({ profileVisibility: "secret" }).success).toBe(
      false,
    );
  });
});

describe("Visibility resolution", () => {
  it("shows a public profile to anyone, including anonymous callers", () => {
    expect(resolveVisibility(baseVisibility)).toBe("full");
    expect(
      resolveVisibility({ ...baseVisibility, viewerId: null, viewerRole: null }),
    ).toBe("full");
  });

  it("redacts a followers-only profile from a non-follower", () => {
    expect(resolveVisibility({ ...baseVisibility, targetVisibility: "followers" })).toBe(
      "redacted",
    );
  });

  it("redacts a followers-only profile from an anonymous caller", () => {
    expect(
      resolveVisibility({
        ...baseVisibility,
        viewerId: null,
        viewerRole: null,
        targetVisibility: "followers",
      }),
    ).toBe("redacted");
  });

  it("opens a followers-only profile to a confirmed follower", () => {
    expect(
      resolveVisibility({
        ...baseVisibility,
        targetVisibility: "followers",
        isFollowing: true,
      }),
    ).toBe("full");
  });

  it("always shows a user their own profile, whatever the setting", () => {
    expect(
      resolveVisibility({
        ...baseVisibility,
        viewerId: "target-1",
        targetVisibility: "followers",
      }),
    ).toBe("full");
  });

  it("lets each admin role through a followers-only profile", () => {
    for (const role of ["moderator", "community_admin", "platform_admin"] as const) {
      expect(
        resolveVisibility({
          ...baseVisibility,
          viewerRole: role,
          targetVisibility: "followers",
        }),
      ).toBe("full");
    }
  });

  it("never treats the frontend's `guest` sentinel as an admin", () => {
    expect(
      resolveVisibility({
        ...baseVisibility,
        viewerRole: "guest",
        targetVisibility: "followers",
      }),
    ).toBe("redacted");
  });

  it("resolves a block to not_found, outranking every other rule", () => {
    // 404 rather than 403: a 403 would confirm the account exists and
    // announce the block. Even an admin sees the block outrank visibility.
    expect(resolveVisibility({ ...baseVisibility, targetBlockedViewer: true })).toBe(
      "not_found",
    );
    expect(
      resolveVisibility({
        ...baseVisibility,
        targetBlockedViewer: true,
        isFollowing: true,
      }),
    ).toBe("not_found");
    expect(
      resolveVisibility({
        ...baseVisibility,
        targetBlockedViewer: true,
        viewerRole: "platform_admin",
      }),
    ).toBe("not_found");
  });
});

describe("Email exposure", () => {
  const base = {
    viewerId: "viewer-1",
    viewerRole: "member" as const,
    targetId: "target-1",
    showEmailOnProfile: false,
  };

  it("hides the email on a public profile by default", () => {
    // Visibility and email exposure are separate rules: a viewer can be
    // allowed the full profile and still not be shown the address.
    expect(canSeeEmail(base)).toBe(false);
  });

  it("shows it when the owner opted in", () => {
    expect(canSeeEmail({ ...base, showEmailOnProfile: true })).toBe(true);
  });

  it("always shows a user their own email", () => {
    expect(canSeeEmail({ ...base, viewerId: "target-1" })).toBe(true);
  });

  it("shows it to admins for moderation", () => {
    expect(canSeeEmail({ ...base, viewerRole: "moderator" })).toBe(true);
  });

  it("hides it from anonymous callers unless opted in", () => {
    expect(canSeeEmail({ ...base, viewerId: null, viewerRole: null })).toBe(false);
    expect(
      canSeeEmail({
        ...base,
        viewerId: null,
        viewerRole: null,
        showEmailOnProfile: true,
      }),
    ).toBe(true);
  });
});

describe("Profile completion", () => {
  const empty: ProfileCompletionInput = {
    avatarUrl: null,
    bannerUrl: null,
    bio: "",
    location: null,
    websiteUrl: null,
    skills: [],
    techStack: [],
    experienceYears: null,
    socialLinksCount: 0,
  };

  const full: ProfileCompletionInput = {
    avatarUrl: "https://cdn/a.png",
    bannerUrl: "https://cdn/b.png",
    bio: "Building in public.",
    location: "Lisbon",
    websiteUrl: "https://example.com",
    skills: ["TypeScript"],
    techStack: ["Node.js"],
    experienceYears: 6,
    socialLinksCount: 2,
  };

  it("scores an empty profile 0 and a complete one 100", () => {
    expect(calculateProfileCompletion(empty)).toBe(0);
    expect(calculateProfileCompletion(full)).toBe(100);
  });

  it("increases monotonically as fields are filled", () => {
    const withBio = calculateProfileCompletion({ ...empty, bio: "Hello" });
    const withBioAndSkills = calculateProfileCompletion({
      ...empty,
      bio: "Hello",
      skills: ["TS"],
    });

    expect(withBio).toBeGreaterThan(0);
    expect(withBioAndSkills).toBeGreaterThan(withBio);
  });

  it("treats whitespace-only text as unfilled", () => {
    expect(calculateProfileCompletion({ ...empty, bio: "   " })).toBe(0);
    expect(calculateProfileCompletion({ ...empty, location: "  " })).toBe(0);
  });

  it("treats an experience of zero years as filled in", () => {
    // 0 is a real answer — a null-vs-zero mix-up would punish beginners.
    expect(calculateProfileCompletion({ ...empty, experienceYears: 0 })).toBeGreaterThan(
      0,
    );
  });

  it("always returns a whole number in range", () => {
    for (const input of [empty, full, { ...empty, bio: "x", skills: ["a"] }]) {
      const score = calculateProfileCompletion(input);
      expect(Number.isInteger(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });
});
