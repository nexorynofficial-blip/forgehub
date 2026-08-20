import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Users and profiles, end to end against real PostgreSQL and Redis.
 *
 * Everything created here is namespaced and removed afterwards, so the suite
 * is safe to run repeatedly against a seeded development database.
 */

vi.mock("../src/integrations/email/index.js", () => ({
  emailService: {
    providerName: "test",
    sendVerificationEmail: () => Promise.resolve(),
    sendPasswordResetEmail: () => Promise.resolve(),
    sendSecurityAlertEmail: () => Promise.resolve(),
  },
}));

const { createApp } = await import("../src/app.js");
const { prisma } = await import("../src/database/prisma.js");
const { connectRedis, redis } = await import("../src/config/redis.js");

const app = createApp();

const NS = "usertest";
const PASSWORD = "ValidPass123";

let counter = 0;
function uniqueEmail(): string {
  counter += 1;
  return `${NS}.${String(counter)}.${String(Date.now())}@forgehub.test`;
}

interface TestUser {
  email: string;
  userId: string;
  username: string;
  token: string;
}

async function createUser(displayName = "Users Tester"): Promise<TestUser> {
  const email = uniqueEmail();

  await request(app)
    .post("/api/v1/auth/register")
    .send({
      displayName,
      email,
      password: PASSWORD,
      confirmPassword: PASSWORD,
      agreeToTerms: true,
    })
    .expect(201);

  const login = await request(app)
    .post("/api/v1/auth/login")
    .send({ email, password: PASSWORD, rememberMe: false })
    .expect(200);

  return {
    email,
    userId: login.body.data.user.id as string,
    username: login.body.data.user.username as string,
    token: login.body.data.accessToken as string,
  };
}

function bearer(token: string): [string, string] {
  return ["Authorization", `Bearer ${token}`];
}

beforeAll(async () => {
  await connectRedis();
});

afterAll(async () => {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: NS } },
    select: { id: true },
  });
  const ids = users.map((user) => user.id);

  if (ids.length > 0) {
    await prisma.auditLog.deleteMany({
      where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] },
    });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  await prisma.$disconnect();
  await redis.quit();
});

describe("Current user", () => {
  it("returns the caller's own record with owner-only fields", async () => {
    const user = await createUser("Self Reader");

    const response = await request(app)
      .get("/api/v1/users/me")
      .set(...bearer(user.token))
      .expect(200);

    expect(response.body.data.user).toMatchObject({
      id: user.userId,
      username: user.username,
      email: user.email,
      role: "member",
    });
    // Owner-only additions beyond the public shape.
    expect(response.body.data.user.emailVerified).toBe(false);
    expect(response.body.data.user.profileCompletion).toEqual(expect.any(Number));
    expect(response.body.data.user.profileVisibility).toBe("public");
  });

  it("requires authentication", async () => {
    await request(app).get("/api/v1/users/me").expect(401);
  });
});

describe("Profile by username", () => {
  it("returns a public profile to an anonymous caller", async () => {
    const user = await createUser("Public Profile");

    const response = await request(app).get(`/api/v1/users/${user.username}`).expect(200);

    expect(response.body.data.user.username).toBe(user.username);
    // No viewer, so there is no relationship to describe.
    expect(response.body.data.relationship).toBeNull();
  });

  it("is case-insensitive on the handle", async () => {
    const user = await createUser("Case Insensitive");

    await request(app).get(`/api/v1/users/${user.username.toUpperCase()}`).expect(200);
  });

  it("404s an unknown username", async () => {
    await request(app).get(`/api/v1/users/${NS}.nobody.here`).expect(404);
  });

  it("422s a malformed username rather than hitting the database", async () => {
    await request(app).get("/api/v1/users/has%20space").expect(422);
  });

  it("includes relationship state for an authenticated viewer", async () => {
    const [viewer, target] = await Promise.all([
      createUser("Viewer"),
      createUser("Target"),
    ]);

    const response = await request(app)
      .get(`/api/v1/users/${target.username}`)
      .set(...bearer(viewer.token))
      .expect(200);

    expect(response.body.data.relationship).toEqual({
      isSelf: false,
      isFollowing: false,
      isFollowedBy: false,
      isBlocking: false,
    });
  });

  it("flags the caller's own profile as self", async () => {
    const user = await createUser("Self Flag");

    const response = await request(app)
      .get(`/api/v1/users/${user.username}`)
      .set(...bearer(user.token))
      .expect(200);

    expect(response.body.data.relationship.isSelf).toBe(true);
  });
});

describe("Profile update", () => {
  it("round-trips the shipped Settings → Account payload", async () => {
    const user = await createUser("Round Trip");

    const patch = {
      displayName: "Updated Name",
      bio: "Building ForgeHub in public.",
      experienceYears: 7,
      skills: ["TypeScript", "Systems Design"],
      techStack: ["Node.js", "PostgreSQL"],
      socialLinks: [
        { platform: "github", url: "https://github.com/example" },
        { platform: "x", url: "https://x.com/example" },
      ],
    };

    const updated = await request(app)
      .patch("/api/v1/users/me")
      .set(...bearer(user.token))
      .send(patch)
      .expect(200);

    expect(updated.body.data.user).toMatchObject({
      displayName: "Updated Name",
      bio: "Building ForgeHub in public.",
      experienceYears: 7,
      skills: ["TypeScript", "Systems Design"],
      techStack: ["Node.js", "PostgreSQL"],
    });

    // Persisted, not just echoed.
    const reread = await request(app).get(`/api/v1/users/${user.username}`).expect(200);
    expect(reread.body.data.user.displayName).toBe("Updated Name");
    expect(reread.body.data.user.socialLinks).toHaveLength(2);
  });

  it("treats socialLinks as a replace set, not a merge", async () => {
    const user = await createUser("Link Replacer");

    await request(app)
      .patch("/api/v1/users/me")
      .set(...bearer(user.token))
      .send({
        socialLinks: [
          { platform: "github", url: "https://github.com/one" },
          { platform: "x", url: "https://x.com/one" },
        ],
      })
      .expect(200);

    // Submitting a shorter list must remove the missing one — a merge would
    // make deleting a social link impossible from the shipped form.
    const response = await request(app)
      .patch("/api/v1/users/me")
      .set(...bearer(user.token))
      .send({ socialLinks: [{ platform: "github", url: "https://github.com/two" }] })
      .expect(200);

    expect(response.body.data.user.socialLinks).toEqual([
      { platform: "github", url: "https://github.com/two" },
    ]);
  });

  it("clears all social links when given an empty array", async () => {
    const user = await createUser("Link Clearer");

    await request(app)
      .patch("/api/v1/users/me")
      .set(...bearer(user.token))
      .send({ socialLinks: [{ platform: "github", url: "https://github.com/x" }] })
      .expect(200);

    const response = await request(app)
      .patch("/api/v1/users/me")
      .set(...bearer(user.token))
      .send({ socialLinks: [] })
      .expect(200);

    expect(response.body.data.user.socialLinks).toEqual([]);
  });

  it("recomputes profile completion from the post-update state", async () => {
    const user = await createUser("Completion");

    const before = await request(app)
      .get("/api/v1/users/me")
      .set(...bearer(user.token))
      .expect(200);

    const after = await request(app)
      .patch("/api/v1/users/me")
      .set(...bearer(user.token))
      .send({
        bio: "Now filled in.",
        skills: ["TypeScript"],
        techStack: ["Node.js"],
        experienceYears: 3,
      })
      .expect(200);

    expect(after.body.data.user.profileCompletion).toBeGreaterThan(
      before.body.data.user.profileCompletion as number,
    );
  });

  it("rejects an empty patch", async () => {
    const user = await createUser("Empty Patch");

    await request(app)
      .patch("/api/v1/users/me")
      .set(...bearer(user.token))
      .send({})
      .expect(422);
  });

  it("accepts the email field unchanged but refuses an actual change", async () => {
    const user = await createUser("Email Guard");

    // The shipped form always posts `email`; an unchanged value must not fail.
    await request(app)
      .patch("/api/v1/users/me")
      .set(...bearer(user.token))
      .send({ email: user.email, bio: "unchanged email is fine" })
      .expect(200);

    // Changing it is a credential operation needing re-verification, and is
    // refused explicitly rather than silently dropped.
    const changed = await request(app)
      .patch("/api/v1/users/me")
      .set(...bearer(user.token))
      .send({ email: `${NS}.hijack.${String(Date.now())}@forgehub.test` })
      .expect(422);

    expect(changed.body.error.message).toMatch(/verification/i);

    const reread = await request(app)
      .get("/api/v1/users/me")
      .set(...bearer(user.token))
      .expect(200);
    expect(reread.body.data.user.email).toBe(user.email);
  });

  it("requires authentication", async () => {
    await request(app).patch("/api/v1/users/me").send({ bio: "hi" }).expect(401);
  });
});

describe("Username change", () => {
  it("changes the handle and serves the profile at the new one", async () => {
    const user = await createUser("Handle Changer");
    const next = `${NS}.renamed.${String(Date.now())}`.slice(0, 30);

    await request(app)
      .patch("/api/v1/users/me/username")
      .set(...bearer(user.token))
      .send({ username: next })
      .expect(200);

    await request(app).get(`/api/v1/users/${next}`).expect(200);
    await request(app).get(`/api/v1/users/${user.username}`).expect(404);
  });

  it("rejects a handle already taken by someone else", async () => {
    const [taker, claimer] = await Promise.all([
      createUser("Handle Owner"),
      createUser("Handle Claimer"),
    ]);

    const response = await request(app)
      .patch("/api/v1/users/me/username")
      .set(...bearer(claimer.token))
      .send({ username: taker.username })
      .expect(409);

    expect(response.body.error.code).toBe("CONFLICT");
  });

  it("treats setting your own current handle as a no-op success", async () => {
    const user = await createUser("Same Handle");

    await request(app)
      .patch("/api/v1/users/me/username")
      .set(...bearer(user.token))
      .send({ username: user.username })
      .expect(200);
  });

  it("enforces the frontend's validation rules server-side", async () => {
    const user = await createUser("Handle Validator");

    for (const bad of ["ab", "has space", "hyphen-ated", "me", "a".repeat(31)]) {
      await request(app)
        .patch("/api/v1/users/me/username")
        .set(...bearer(user.token))
        .send({ username: bad })
        .expect(422);
    }
  });

  it("records the change in the audit log", async () => {
    const user = await createUser("Handle Audited");
    const next = `${NS}.audited.${String(Date.now())}`.slice(0, 30);

    await request(app)
      .patch("/api/v1/users/me/username")
      .set(...bearer(user.token))
      .send({ username: next })
      .expect(200);

    const entry = await prisma.auditLog.findFirst({
      where: { actorId: user.userId, action: "USERNAME_CHANGED" },
    });
    expect(entry).not.toBeNull();
  });

  it("can also be changed through the profile patch, as the form does", async () => {
    const user = await createUser("Inline Handle");
    const next = `${NS}.inline.${String(Date.now())}`.slice(0, 30);

    const response = await request(app)
      .patch("/api/v1/users/me")
      .set(...bearer(user.token))
      .send({ username: next, bio: "changed together" })
      .expect(200);

    expect(response.body.data.user.username).toBe(next);
    expect(response.body.data.user.bio).toBe("changed together");
  });
});

describe("Privacy settings", () => {
  it("returns the frontend's PrivacySettings shape", async () => {
    const user = await createUser("Settings Reader");

    const response = await request(app)
      .get("/api/v1/users/me/settings")
      .set(...bearer(user.token))
      .expect(200);

    expect(response.body.data.settings).toEqual({
      profileVisibility: "public",
      showEmailOnProfile: false,
      whoCanMessage: "everyone",
      twoFactorEnabled: false,
    });
  });

  it("round-trips an update across all three backing tables", async () => {
    const user = await createUser("Settings Writer");

    const updated = await request(app)
      .patch("/api/v1/users/me/settings")
      .set(...bearer(user.token))
      .send({
        profileVisibility: "followers",
        showEmailOnProfile: true,
        whoCanMessage: "followers",
      })
      .expect(200);

    expect(updated.body.data.settings).toMatchObject({
      profileVisibility: "followers",
      showEmailOnProfile: true,
      whoCanMessage: "followers",
    });

    const reread = await request(app)
      .get("/api/v1/users/me/settings")
      .set(...bearer(user.token))
      .expect(200);
    expect(reread.body.data.settings.profileVisibility).toBe("followers");
  });

  it("ignores an attempt to enable 2FA through settings", async () => {
    const user = await createUser("2FA Backdoor");

    await request(app)
      .patch("/api/v1/users/me/settings")
      .set(...bearer(user.token))
      .send({ showEmailOnProfile: true, twoFactorEnabled: true })
      .expect(200);

    // 2FA is owned by the enrollment flow, which requires a verified code.
    const settings = await request(app)
      .get("/api/v1/users/me/settings")
      .set(...bearer(user.token))
      .expect(200);
    expect(settings.body.data.settings.twoFactorEnabled).toBe(false);

    const credential = await prisma.twoFactorCredential.findUnique({
      where: { userId: user.userId },
    });
    expect(credential).toBeNull();
  });

  it("rejects an empty or invalid settings patch", async () => {
    const user = await createUser("Settings Validator");

    await request(app)
      .patch("/api/v1/users/me/settings")
      .set(...bearer(user.token))
      .send({})
      .expect(422);

    await request(app)
      .patch("/api/v1/users/me/settings")
      .set(...bearer(user.token))
      .send({ profileVisibility: "secret" })
      .expect(422);
  });
});

describe("Notification preferences", () => {
  it("returns a complete matrix, one row per notification type", async () => {
    const user = await createUser("Prefs Reader");

    const response = await request(app)
      .get("/api/v1/users/me/notification-preferences")
      .set(...bearer(user.token))
      .expect(200);

    const prefs = response.body.data.preferences as Record<string, unknown>;
    const types = Object.keys(prefs);

    // Registration seeds one row per enum value; the Settings grid is fixed.
    expect(types.length).toBeGreaterThanOrEqual(12);
    expect(prefs["like"]).toEqual({ inApp: true, email: false });
    expect(prefs["follower"]).toEqual({ inApp: true, email: false });
  });

  it("updates a single channel and leaves the rest untouched", async () => {
    const user = await createUser("Prefs Writer");

    const response = await request(app)
      .patch("/api/v1/users/me/notification-preferences")
      .set(...bearer(user.token))
      .send({ type: "follower", email: true })
      .expect(200);

    const prefs = response.body.data.preferences as Record<
      string,
      { inApp: boolean; email: boolean }
    >;

    expect(prefs["follower"]).toEqual({ inApp: true, email: true });
    expect(prefs["like"]).toEqual({ inApp: true, email: false });
  });

  it("can turn a channel off as well as on", async () => {
    const user = await createUser("Prefs Toggler");

    await request(app)
      .patch("/api/v1/users/me/notification-preferences")
      .set(...bearer(user.token))
      .send({ type: "mention", inApp: false })
      .expect(200);

    const response = await request(app)
      .get("/api/v1/users/me/notification-preferences")
      .set(...bearer(user.token))
      .expect(200);

    expect(response.body.data.preferences.mention).toEqual({
      inApp: false,
      email: false,
    });
  });

  it("rejects an unknown type or a patch with no channel", async () => {
    const user = await createUser("Prefs Validator");

    await request(app)
      .patch("/api/v1/users/me/notification-preferences")
      .set(...bearer(user.token))
      .send({ type: "not_a_type", inApp: true })
      .expect(422);

    await request(app)
      .patch("/api/v1/users/me/notification-preferences")
      .set(...bearer(user.token))
      .send({ type: "follower" })
      .expect(422);
  });
});

describe("Achievements", () => {
  it("returns achievements and badges for a public profile", async () => {
    const user = await createUser("Achievement Reader");

    const response = await request(app)
      .get(`/api/v1/users/${user.username}/achievements`)
      .expect(200);

    expect(Array.isArray(response.body.data.achievements)).toBe(true);
    expect(Array.isArray(response.body.data.badges)).toBe(true);
  });

  it("404s for an unknown user", async () => {
    await request(app).get(`/api/v1/users/${NS}.ghost/achievements`).expect(404);
  });
});
