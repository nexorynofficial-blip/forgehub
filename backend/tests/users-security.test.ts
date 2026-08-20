import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Authorization, privacy, and projection for Phase 4.
 *
 * Everything here asserts something that would still let the product "work"
 * if it broke: a profile that quietly serves someone else's email, a
 * followers-only setting that the follower list walks around, an endpoint
 * that trusts a path parameter over the token. Those are the regressions the
 * happy-path suites cannot see.
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

const NS = "usersec";
const PASSWORD = "ValidPass123";

/** Exactly the keys of the shipped frontend's `User` (`src/types/user.ts`). */
const FRONTEND_USER_KEYS = [
  "achievements",
  "avatarUrl",
  "badges",
  "bannerUrl",
  "bio",
  "builderRank",
  "communityScore",
  "contributionScore",
  "createdAt",
  "dailyStreak",
  "displayName",
  "email",
  "experienceYears",
  "followersCount",
  "followingCount",
  "id",
  "projectsCount",
  "role",
  "skills",
  "socialLinks",
  "techStack",
  "username",
  "xp",
].sort();

/** Columns that must never appear in any response, at any nesting depth. */
const FORBIDDEN_KEYS = [
  "passwordHash",
  "password",
  "tokenHash",
  "refreshToken",
  "secret",
  "backupCodes",
  "twoFactor",
  "sessions",
  "emailTokens",
  "passwordResetTokens",
  "deletedAt",
];

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

async function createUser(displayName = "Sec Tester"): Promise<TestUser> {
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

/** Promotes a user and re-logs in so the session reflects the new role. */
async function makeAdmin(user: TestUser): Promise<string> {
  await prisma.user.update({
    where: { id: user.userId },
    data: { role: "platform_admin" },
  });

  const login = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: user.email, password: PASSWORD, rememberMe: false })
    .expect(200);

  return login.body.data.accessToken as string;
}

async function setVisibility(user: TestUser, visibility: "public" | "followers") {
  await request(app)
    .patch("/api/v1/users/me/settings")
    .set(...bearer(user.token))
    .send({ profileVisibility: visibility })
    .expect(200);
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

describe("Ownership: a caller may only write their own record", () => {
  it("has no endpoint shape that targets another user's profile", async () => {
    const [owner, attacker] = await Promise.all([createUser(), createUser()]);

    // The write endpoints are addressed as /users/me — identity comes from
    // the token, so there is no path parameter to point elsewhere. Attempting
    // to address the victim's handle must not resolve to a writable route.
    await request(app)
      .patch(`/api/v1/users/${owner.username}`)
      .set(...bearer(attacker.token))
      .send({ bio: "hijacked" })
      .expect(404);

    const profile = await request(app).get(`/api/v1/users/${owner.username}`).expect(200);
    expect(profile.body.data.user.bio).not.toBe("hijacked");
  });

  it("ignores a userId smuggled into the update payload", async () => {
    const [owner, attacker] = await Promise.all([createUser(), createUser()]);

    await request(app)
      .patch("/api/v1/users/me")
      .set(...bearer(attacker.token))
      .send({ id: owner.userId, userId: owner.userId, bio: "written by attacker" })
      .expect(200);

    // The write landed on the attacker, not the id they supplied.
    const victim = await request(app).get(`/api/v1/users/${owner.username}`).expect(200);
    expect(victim.body.data.user.bio).toBe("");

    const self = await request(app).get(`/api/v1/users/${attacker.username}`).expect(200);
    expect(self.body.data.user.bio).toBe("written by attacker");
  });

  it("keeps settings and preferences scoped to the caller", async () => {
    const [owner, attacker] = await Promise.all([createUser(), createUser()]);

    await request(app)
      .patch("/api/v1/users/me/settings")
      .set(...bearer(attacker.token))
      .send({ userId: owner.userId, profileVisibility: "followers" })
      .expect(200);

    await request(app)
      .patch("/api/v1/users/me/notification-preferences")
      .set(...bearer(attacker.token))
      .send({ userId: owner.userId, type: "follower", email: true })
      .expect(200);

    const victimSettings = await request(app)
      .get("/api/v1/users/me/settings")
      .set(...bearer(owner.token))
      .expect(200);
    expect(victimSettings.body.data.settings.profileVisibility).toBe("public");

    const victimPrefs = await request(app)
      .get("/api/v1/users/me/notification-preferences")
      .set(...bearer(owner.token))
      .expect(200);
    expect(victimPrefs.body.data.preferences.follower.email).toBe(false);
  });

  it("rejects every write endpoint without a token", async () => {
    for (const path of [
      "/api/v1/users/me",
      "/api/v1/users/me/username",
      "/api/v1/users/me/settings",
      "/api/v1/users/me/notification-preferences",
    ]) {
      await request(app).patch(path).send({ bio: "x" }).expect(401);
    }
  });
});

describe("Followers-only visibility", () => {
  it("redacts the profile for a non-follower", async () => {
    const [owner, viewer] = await Promise.all([createUser(), createUser()]);
    await request(app)
      .patch("/api/v1/users/me")
      .set(...bearer(owner.token))
      .send({ bio: "private thoughts", skills: ["Secret Skill"] })
      .expect(200);
    await setVisibility(owner, "followers");

    const response = await request(app)
      .get(`/api/v1/users/${owner.username}`)
      .set(...bearer(viewer.token))
      .expect(200);

    const user = response.body.data.user as Record<string, unknown>;

    expect(user["restricted"]).toBe(true);
    // Identity survives; authored content does not.
    expect(user["username"]).toBe(owner.username);
    for (const field of [
      "bio",
      "skills",
      "techStack",
      "socialLinks",
      "email",
      "achievements",
      "badges",
      "experienceYears",
      "xp",
    ]) {
      expect(user).not.toHaveProperty(field);
    }
    expect(JSON.stringify(response.body)).not.toContain("private thoughts");
    expect(JSON.stringify(response.body)).not.toContain("Secret Skill");
  });

  it("redacts for anonymous callers too", async () => {
    const owner = await createUser();
    await setVisibility(owner, "followers");

    const response = await request(app)
      .get(`/api/v1/users/${owner.username}`)
      .expect(200);

    expect(response.body.data.user.restricted).toBe(true);
  });

  it("opens the full profile to a confirmed follower", async () => {
    const [owner, follower] = await Promise.all([createUser(), createUser()]);
    await request(app)
      .patch("/api/v1/users/me")
      .set(...bearer(owner.token))
      .send({ bio: "visible to followers" })
      .expect(200);
    await setVisibility(owner, "followers");

    await request(app)
      .post(`/api/v1/users/${owner.username}/follow`)
      .set(...bearer(follower.token))
      .expect(201);

    const response = await request(app)
      .get(`/api/v1/users/${owner.username}`)
      .set(...bearer(follower.token))
      .expect(200);

    expect(response.body.data.user.restricted).toBeUndefined();
    expect(response.body.data.user.bio).toBe("visible to followers");
  });

  it("still shows the owner their own full profile", async () => {
    const owner = await createUser();
    await setVisibility(owner, "followers");

    const response = await request(app)
      .get(`/api/v1/users/${owner.username}`)
      .set(...bearer(owner.token))
      .expect(200);

    expect(response.body.data.user.restricted).toBeUndefined();
  });

  it("does not let the follower list walk around the setting", async () => {
    const [owner, follower, stranger] = await Promise.all([
      createUser(),
      createUser(),
      createUser(),
    ]);
    await request(app)
      .post(`/api/v1/users/${owner.username}/follow`)
      .set(...bearer(follower.token))
      .expect(201);
    await setVisibility(owner, "followers");

    // Without the gate, a private profile would still hand out its entire
    // social graph to anyone who asked.
    await request(app)
      .get(`/api/v1/users/${owner.username}/followers`)
      .set(...bearer(stranger.token))
      .expect(404);
    await request(app)
      .get(`/api/v1/users/${owner.username}/following`)
      .set(...bearer(stranger.token))
      .expect(404);
    await request(app).get(`/api/v1/users/${owner.username}/followers`).expect(404);

    // …but a follower may read it.
    await request(app)
      .get(`/api/v1/users/${owner.username}/followers`)
      .set(...bearer(follower.token))
      .expect(200);
  });

  it("does not leak achievements through the side door", async () => {
    const [owner, stranger] = await Promise.all([createUser(), createUser()]);
    await setVisibility(owner, "followers");

    await request(app)
      .get(`/api/v1/users/${owner.username}/achievements`)
      .set(...bearer(stranger.token))
      .expect(403);
  });
});

describe("Blocked viewers", () => {
  it("makes the profile indistinguishable from a non-existent account", async () => {
    const [owner, blocked] = await Promise.all([createUser(), createUser()]);

    await request(app)
      .post(`/api/v1/users/${blocked.username}/block`)
      .set(...bearer(owner.token))
      .expect(201);

    const blockedResponse = await request(app)
      .get(`/api/v1/users/${owner.username}`)
      .set(...bearer(blocked.token))
      .expect(404);

    const ghostResponse = await request(app)
      .get(`/api/v1/users/${NS}.doesnotexist`)
      .set(...bearer(blocked.token))
      .expect(404);

    // Byte-identical: a 403 would confirm the account exists and announce
    // the block, which the blocker never consented to disclosing.
    expect(blockedResponse.body).toEqual(ghostResponse.body);
  });

  it("hides the blocked user's follower lists from them as well", async () => {
    const [owner, blocked] = await Promise.all([createUser(), createUser()]);

    await request(app)
      .post(`/api/v1/users/${blocked.username}/block`)
      .set(...bearer(owner.token))
      .expect(201);

    await request(app)
      .get(`/api/v1/users/${owner.username}/followers`)
      .set(...bearer(blocked.token))
      .expect(404);
  });

  it("leaves the profile visible to everyone else", async () => {
    const [owner, blocked, bystander] = await Promise.all([
      createUser(),
      createUser(),
      createUser(),
    ]);

    await request(app)
      .post(`/api/v1/users/${blocked.username}/block`)
      .set(...bearer(owner.token))
      .expect(201);

    await request(app)
      .get(`/api/v1/users/${owner.username}`)
      .set(...bearer(bystander.token))
      .expect(200);
  });

  it("never tells a user that they have been blocked", async () => {
    const [owner, blocked] = await Promise.all([createUser(), createUser()]);

    await request(app)
      .post(`/api/v1/users/${blocked.username}/block`)
      .set(...bearer(owner.token))
      .expect(201);

    // The blocker sees `isBlocking`; the blocked party gets no field at all.
    const blockerView = await request(app)
      .get(`/api/v1/users/${blocked.username}/relationship`)
      .set(...bearer(owner.token))
      .expect(200);
    expect(blockerView.body.data.relationship.isBlocking).toBe(true);

    const blockedView = await request(app)
      .get(`/api/v1/users/${owner.username}/relationship`)
      .set(...bearer(blocked.token))
      .expect(200);
    expect(blockedView.body.data.relationship).not.toHaveProperty("isBlockedBy");
    expect(JSON.stringify(blockedView.body)).not.toMatch(/blockedBy/i);
  });
});

describe("Admin override", () => {
  it("lets an admin read a followers-only profile in full", async () => {
    const [owner, admin] = await Promise.all([createUser(), createUser()]);
    await request(app)
      .patch("/api/v1/users/me")
      .set(...bearer(owner.token))
      .send({ bio: "moderation target" })
      .expect(200);
    await setVisibility(owner, "followers");

    const adminToken = await makeAdmin(admin);

    const response = await request(app)
      .get(`/api/v1/users/${owner.username}`)
      .set(...bearer(adminToken))
      .expect(200);

    expect(response.body.data.user.restricted).toBeUndefined();
    expect(response.body.data.user.bio).toBe("moderation target");
  });

  it("shows an admin the email even without showEmailOnProfile", async () => {
    const [owner, admin] = await Promise.all([createUser(), createUser()]);
    const adminToken = await makeAdmin(admin);

    const response = await request(app)
      .get(`/api/v1/users/${owner.username}`)
      .set(...bearer(adminToken))
      .expect(200);

    expect(response.body.data.user.email).toBe(owner.email);
  });

  it("does not let an admin override a block", async () => {
    const [owner, admin] = await Promise.all([createUser(), createUser()]);
    const adminToken = await makeAdmin(admin);

    await request(app)
      .post(`/api/v1/users/${admin.username}/block`)
      .set(...bearer(owner.token))
      .expect(201);

    // Blocking outranks the admin role in the visibility rule. Moderation
    // tooling is a Phase 11 surface with its own audited endpoints.
    await request(app)
      .get(`/api/v1/users/${owner.username}`)
      .set(...bearer(adminToken))
      .expect(404);
  });

  it("gives an ordinary member no override at all", async () => {
    const [owner, member] = await Promise.all([createUser(), createUser()]);
    await setVisibility(owner, "followers");

    const response = await request(app)
      .get(`/api/v1/users/${owner.username}`)
      .set(...bearer(member.token))
      .expect(200);

    expect(response.body.data.user.restricted).toBe(true);
  });
});

describe("Email privacy", () => {
  it("hides the email on a public profile by default", async () => {
    const [owner, viewer] = await Promise.all([createUser(), createUser()]);

    const response = await request(app)
      .get(`/api/v1/users/${owner.username}`)
      .set(...bearer(viewer.token))
      .expect(200);

    expect(response.body.data.user.email).toBeNull();
    expect(JSON.stringify(response.body)).not.toContain(owner.email);
  });

  it("exposes it once the owner opts in", async () => {
    const [owner, viewer] = await Promise.all([createUser(), createUser()]);

    await request(app)
      .patch("/api/v1/users/me/settings")
      .set(...bearer(owner.token))
      .send({ showEmailOnProfile: true })
      .expect(200);

    const response = await request(app)
      .get(`/api/v1/users/${owner.username}`)
      .set(...bearer(viewer.token))
      .expect(200);

    expect(response.body.data.user.email).toBe(owner.email);
  });

  it("always shows a user their own email", async () => {
    const owner = await createUser();

    const response = await request(app)
      .get(`/api/v1/users/${owner.username}`)
      .set(...bearer(owner.token))
      .expect(200);

    expect(response.body.data.user.email).toBe(owner.email);
  });

  it("hides it from anonymous callers", async () => {
    const owner = await createUser();

    const response = await request(app)
      .get(`/api/v1/users/${owner.username}`)
      .expect(200);

    expect(response.body.data.user.email).toBeNull();
  });
});

describe("Response projection", () => {
  it("matches the shipped frontend User contract exactly", async () => {
    const [owner, viewer] = await Promise.all([createUser(), createUser()]);

    const response = await request(app)
      .get(`/api/v1/users/${owner.username}`)
      .set(...bearer(viewer.token))
      .expect(200);

    // Exact key equality, not a subset check: an extra key is as much a
    // contract break as a missing one when the frontend renders this shape.
    expect(Object.keys(response.body.data.user).sort()).toEqual(FRONTEND_USER_KEYS);
  });

  it("adds only the documented owner-only fields on /users/me", async () => {
    const owner = await createUser();

    const response = await request(app)
      .get("/api/v1/users/me")
      .set(...bearer(owner.token))
      .expect(200);

    expect(Object.keys(response.body.data.user).sort()).toEqual(
      [
        ...FRONTEND_USER_KEYS,
        "emailVerified",
        "profileCompletion",
        "profileVisibility",
      ].sort(),
    );
  });

  it("never leaks a credential or internal column from any user endpoint", async () => {
    const owner = await createUser();
    await request(app)
      .post(`/api/v1/users/${owner.username}/follow`)
      .set(...bearer((await createUser()).token))
      .expect(201);

    const responses = await Promise.all([
      request(app)
        .get("/api/v1/users/me")
        .set(...bearer(owner.token)),
      request(app).get(`/api/v1/users/${owner.username}`),
      request(app)
        .get("/api/v1/users/me/settings")
        .set(...bearer(owner.token)),
      request(app)
        .get("/api/v1/users/me/notification-preferences")
        .set(...bearer(owner.token)),
      request(app).get(`/api/v1/users/${owner.username}/followers`),
      request(app)
        .get("/api/v1/users/me/blocks")
        .set(...bearer(owner.token)),
    ]);

    for (const response of responses) {
      const body = JSON.stringify(response.body);
      for (const key of FORBIDDEN_KEYS) {
        expect(body).not.toContain(`"${key}"`);
      }
      expect(body).not.toContain("$argon2");
      expect(body).not.toContain(PASSWORD);
    }
  });

  it("keeps the follower preview to exactly the frontend's four fields", async () => {
    const [owner, follower] = await Promise.all([createUser(), createUser()]);
    await request(app)
      .post(`/api/v1/users/${owner.username}/follow`)
      .set(...bearer(follower.token))
      .expect(201);

    const response = await request(app)
      .get(`/api/v1/users/${owner.username}/followers`)
      .expect(200);

    expect(Object.keys(response.body.data.items[0]).sort()).toEqual([
      "avatarUrl",
      "displayName",
      "id",
      "username",
    ]);
  });

  it("serves reputation fields as read-only", async () => {
    const owner = await createUser();

    // The profile patch must not be a back door into XP or rank.
    await request(app)
      .patch("/api/v1/users/me")
      .set(...bearer(owner.token))
      .send({
        bio: "trying",
        xp: 999_999,
        builderRank: "Legendary",
        followersCount: 500,
      })
      .expect(200);

    const response = await request(app)
      .get("/api/v1/users/me")
      .set(...bearer(owner.token))
      .expect(200);

    expect(response.body.data.user.xp).toBe(0);
    expect(response.body.data.user.builderRank).toBe("Newcomer");
    expect(response.body.data.user.followersCount).toBe(0);
  });
});

describe("OpenAPI synchronization", () => {
  it("documents every user and social-graph route the router mounts", async () => {
    const response = await request(app).get("/api/v1/openapi.json").expect(200);
    const paths = Object.keys(response.body.paths as Record<string, unknown>);

    expect(paths).toEqual(
      expect.arrayContaining([
        "/users/me",
        "/users/me/username",
        "/users/me/settings",
        "/users/me/notification-preferences",
        "/users/me/blocks",
        "/users/{username}",
        "/users/{username}/achievements",
        "/users/{username}/followers",
        "/users/{username}/following",
        "/users/{username}/relationship",
        "/users/{username}/follow",
        "/users/{username}/block",
      ]),
    );
  });

  it("documents the UserProfile schema as the frontend's contract", async () => {
    const response = await request(app).get("/api/v1/openapi.json").expect(200);
    const required = response.body.components.schemas.UserProfile.required as string[];

    expect([...required].sort()).toEqual(FRONTEND_USER_KEYS);
  });

  it("does not document an isBlockedBy field on Relationship", async () => {
    const response = await request(app).get("/api/v1/openapi.json").expect(200);
    const relationship = JSON.stringify(
      response.body.components.schemas.Relationship as unknown,
    );

    expect(relationship).not.toContain("isBlockedBy");
  });
});
