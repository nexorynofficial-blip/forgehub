import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Community membership, roles, and ownership over HTTP (Phase 7, J4–J7).
 *
 * The authorization matrix is exercised end to end rather than only against the
 * pure table in `communities-unit.test.ts`: a correct table wired to the wrong
 * service call is still a privilege-escalation bug, and only a request can
 * prove the two are connected.
 *
 * Every counter assertion reads the database directly afterwards. A 200 that
 * left `memberCount` disagreeing with the membership rows is the failure mode
 * this phase is most exposed to.
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

const NS = "cmembers";
const PASSWORD = "ValidPass123";
const BASE = "/api/v1/communities";

let counter = 0;
function uniqueEmail(): string {
  counter += 1;
  return `${NS}.${String(counter)}.${String(Date.now())}@forgehub.test`;
}

interface TestUser {
  userId: string;
  username: string;
  token: string;
}

async function createUser(displayName = "Member Tester"): Promise<TestUser> {
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
    userId: login.body.data.user.id as string,
    username: login.body.data.user.username as string,
    token: login.body.data.accessToken as string,
  };
}

function bearer(token: string): [string, string] {
  return ["Authorization", `Bearer ${token}`];
}

let n = 0;
async function makeCommunity(
  actor: TestUser,
  body: Record<string, unknown> = {},
): Promise<{ slug: string; id: string }> {
  n += 1;
  const response = await request(app)
    .post(BASE)
    .set(...bearer(actor.token))
    .send({ name: `${NS} Community ${String(n)}`, category: "Testing", ...body })
    .expect(201);

  const community = response.body.data.community as { id: string; slug: string };
  return { slug: community.slug, id: community.id };
}

/** Adds a member at a given role, straight through the API as the owner. */
async function seatMember(
  slug: string,
  owner: TestUser,
  target: TestUser,
  role: string,
): Promise<void> {
  await request(app)
    .post(`${BASE}/${slug}/members`)
    .set(...bearer(owner.token))
    .send({ username: target.username, role })
    .expect(201);
}

async function counters(communityId: string) {
  const [row, rows] = await Promise.all([
    prisma.community.findUniqueOrThrow({
      where: { id: communityId },
      select: { memberCount: true, ownerId: true },
    }),
    prisma.communityMember.count({ where: { communityId } }),
  ]);
  return { counter: row.memberCount, rows, ownerId: row.ownerId };
}

let owner: TestUser;
let admin: TestUser;
let moderator: TestUser;
let plain: TestUser;
let outsider: TestUser;

beforeAll(async () => {
  await connectRedis();
  owner = await createUser("Comm Owner");
  admin = await createUser("Comm Admin");
  moderator = await createUser("Comm Moderator");
  plain = await createUser("Comm Member");
  outsider = await createUser("Comm Outsider");
});

afterAll(async () => {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: NS } },
    select: { id: true },
  });
  const ids = users.map((user) => user.id);

  if (ids.length > 0) {
    const communities = await prisma.community.findMany({
      where: { ownerId: { in: ids } },
      select: { id: true },
    });
    const communityIds = communities.map((row) => row.id);

    if (communityIds.length > 0) {
      // Release tags before deleting, or `Tag.usageCount` is left inflated.
      const held = await prisma.communityTag.findMany({
        where: { communityId: { in: communityIds } },
        select: { tagId: true },
      });
      await prisma.communityTag.deleteMany({
        where: { communityId: { in: communityIds } },
      });
      for (const { tagId } of held) {
        await prisma.tag.updateMany({
          where: { id: tagId, usageCount: { gt: 0 } },
          data: { usageCount: { decrement: 1 } },
        });
      }
      await prisma.community.deleteMany({ where: { id: { in: communityIds } } });
    }

    await prisma.auditLog.deleteMany({
      where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] },
    });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  await prisma.$disconnect();
  await redis.quit();
});

/* ══ Self-service join and leave (decision J5) ════════════════════════════ */

describe("Self-join", () => {
  it("joins a public community immediately", async () => {
    const community = await makeCommunity(owner, { visibility: "public" });
    const joiner = await createUser();

    const response = await request(app)
      .post(`${BASE}/${community.slug}/join`)
      .set(...bearer(joiner.token))
      .expect(201);

    expect(response.body.data.viewer.isMember).toBe(true);
    expect(response.body.data.viewer.role).toBe("member");
    expect(await counters(community.id)).toMatchObject({ counter: 2, rows: 2 });
  });

  it("joins an unlisted community reached by slug", async () => {
    const community = await makeCommunity(owner, { visibility: "unlisted" });
    const joiner = await createUser();

    await request(app)
      .post(`${BASE}/${community.slug}/join`)
      .set(...bearer(joiner.token))
      .expect(201);
  });

  it("404s a private community rather than revealing it exists", async () => {
    // The visibility gate fires before the join rule is ever consulted.
    const community = await makeCommunity(owner, { visibility: "private" });
    const joiner = await createUser();

    await request(app)
      .post(`${BASE}/${community.slug}/join`)
      .set(...bearer(joiner.token))
      .expect(404);
  });

  it("409s a duplicate join and leaves the counter alone", async () => {
    const community = await makeCommunity(owner, { visibility: "public" });
    const joiner = await createUser();

    await request(app)
      .post(`${BASE}/${community.slug}/join`)
      .set(...bearer(joiner.token))
      .expect(201);
    await request(app)
      .post(`${BASE}/${community.slug}/join`)
      .set(...bearer(joiner.token))
      .expect(409);

    expect(await counters(community.id)).toMatchObject({ counter: 2, rows: 2 });
  });

  it("requires authentication", async () => {
    const community = await makeCommunity(owner, { visibility: "public" });
    await request(app).post(`${BASE}/${community.slug}/join`).expect(401);
  });
});

describe("Leave", () => {
  it("lets a member leave and moves the counter back", async () => {
    const community = await makeCommunity(owner, { visibility: "public" });
    const joiner = await createUser();

    await request(app)
      .post(`${BASE}/${community.slug}/join`)
      .set(...bearer(joiner.token))
      .expect(201);
    await request(app)
      .delete(`${BASE}/${community.slug}/leave`)
      .set(...bearer(joiner.token))
      .expect(200);

    expect(await counters(community.id)).toMatchObject({ counter: 1, rows: 1 });
  });

  it("409s when the caller was never a member", async () => {
    const community = await makeCommunity(owner, { visibility: "public" });

    await request(app)
      .delete(`${BASE}/${community.slug}/leave`)
      .set(...bearer(outsider.token))
      .expect(409);
  });

  it("refuses to let the owner leave (422), preserving the owner invariant", async () => {
    const community = await makeCommunity(owner);

    await request(app)
      .delete(`${BASE}/${community.slug}/leave`)
      .set(...bearer(owner.token))
      .expect(422);

    const state = await counters(community.id);
    expect(state.rows).toBe(1);
    const ownerRow = await prisma.communityMember.findFirst({
      where: { communityId: community.id, userId: owner.userId },
      select: { role: true },
    });
    expect(ownerRow?.role).toBe("owner");
  });
});

/* ══ The authorization matrix (decision J4) ═══════════════════════════════ */

describe("Authorization matrix", () => {
  /** A community seated with one of each role. */
  async function seated() {
    const community = await makeCommunity(owner, { visibility: "public" });
    await seatMember(community.slug, owner, admin, "admin");
    await seatMember(community.slug, owner, moderator, "moderator");
    await seatMember(community.slug, owner, plain, "member");
    return community;
  }

  it("lets the owner edit, and refuses everyone below admin", async () => {
    const community = await seated();

    for (const [actor, expected] of [
      [owner, 200],
      [admin, 200],
      [moderator, 403],
      [plain, 403],
      [outsider, 403],
    ] as const) {
      await request(app)
        .patch(`${BASE}/${community.slug}`)
        .set(...bearer(actor.token))
        .send({ description: `edited by ${actor.username}` })
        .expect(expected);
    }
  });

  it("lets only the owner delete the community", async () => {
    for (const [actor, expected] of [
      [admin, 403],
      [moderator, 403],
      [plain, 403],
      [owner, 200],
    ] as const) {
      const community = await seated();
      await request(app)
        .delete(`${BASE}/${community.slug}`)
        .set(...bearer(actor.token))
        .expect(expected);
    }
  });

  it("lets only the owner transfer ownership", async () => {
    for (const actor of [admin, moderator, plain]) {
      const community = await seated();
      await request(app)
        .post(`${BASE}/${community.slug}/transfer`)
        .set(...bearer(actor.token))
        .send({ username: plain.username })
        .expect(403);
    }
  });

  it("lets owner and admin add members, and refuses moderator and below", async () => {
    for (const [actor, expected] of [
      [owner, 201],
      [admin, 201],
      [moderator, 403],
      [plain, 403],
      [outsider, 403],
    ] as const) {
      const community = await seated();
      const newcomer = await createUser();

      await request(app)
        .post(`${BASE}/${community.slug}/members`)
        .set(...bearer(actor.token))
        .send({ username: newcomer.username })
        .expect(expected);
    }
  });

  it("refuses a moderator any role change", async () => {
    const community = await seated();

    await request(app)
      .patch(`${BASE}/${community.slug}/members/${plain.username}`)
      .set(...bearer(moderator.token))
      .send({ role: "moderator" })
      .expect(403);
  });

  it("refuses a non-member every managed action, on a public community", async () => {
    const community = await seated();

    await request(app)
      .post(`${BASE}/${community.slug}/members`)
      .set(...bearer(outsider.token))
      .send({ username: plain.username })
      .expect(403);
    await request(app)
      .delete(`${BASE}/${community.slug}/members/${plain.username}`)
      .set(...bearer(outsider.token))
      .expect(403);
    await request(app)
      .patch(`${BASE}/${community.slug}/members/${plain.username}`)
      .set(...bearer(outsider.token))
      .send({ role: "moderator" })
      .expect(403);
  });

  it("404s every managed action on a private community for a non-member", async () => {
    // 404 not 403: the community's existence is not the outsider's business.
    const community = await makeCommunity(owner, { visibility: "private" });

    await request(app)
      .patch(`${BASE}/${community.slug}`)
      .set(...bearer(outsider.token))
      .send({ description: "nope" })
      .expect(404);
    await request(app)
      .post(`${BASE}/${community.slug}/members`)
      .set(...bearer(outsider.token))
      .send({ username: plain.username })
      .expect(404);
    await request(app)
      .get(`${BASE}/${community.slug}/members`)
      .set(...bearer(outsider.token))
      .expect(404);
  });
});

/* ══ Role changes and escalation (decision J4) ════════════════════════════ */

describe("Role changes", () => {
  it("lets the owner promote a member to admin", async () => {
    const community = await makeCommunity(owner);
    const target = await createUser();
    await seatMember(community.slug, owner, target, "member");

    const response = await request(app)
      .patch(`${BASE}/${community.slug}/members/${target.username}`)
      .set(...bearer(owner.token))
      .send({ role: "admin" })
      .expect(200);

    expect(response.body.data.member.role).toBe("admin");
  });

  it("refuses an admin promoting anyone to admin (no minting peers)", async () => {
    const community = await makeCommunity(owner);
    await seatMember(community.slug, owner, admin, "admin");
    const target = await createUser();
    await seatMember(community.slug, owner, target, "member");

    await request(app)
      .patch(`${BASE}/${community.slug}/members/${target.username}`)
      .set(...bearer(admin.token))
      .send({ role: "admin" })
      .expect(403);
  });

  it("refuses an admin demoting a peer admin", async () => {
    const community = await makeCommunity(owner);
    const adminA = await createUser();
    const adminB = await createUser();
    await seatMember(community.slug, owner, adminA, "admin");
    await seatMember(community.slug, owner, adminB, "admin");

    await request(app)
      .patch(`${BASE}/${community.slug}/members/${adminB.username}`)
      .set(...bearer(adminA.token))
      .send({ role: "member" })
      .expect(403);
  });

  it("lets an admin manage a moderator", async () => {
    const community = await makeCommunity(owner);
    await seatMember(community.slug, owner, admin, "admin");
    const target = await createUser();
    await seatMember(community.slug, owner, target, "moderator");

    await request(app)
      .patch(`${BASE}/${community.slug}/members/${target.username}`)
      .set(...bearer(admin.token))
      .send({ role: "member" })
      .expect(200);
  });

  it("refuses the `owner` role through the member routes (422)", async () => {
    const community = await makeCommunity(owner);
    const target = await createUser();
    await seatMember(community.slug, owner, target, "member");

    await request(app)
      .patch(`${BASE}/${community.slug}/members/${target.username}`)
      .set(...bearer(owner.token))
      .send({ role: "owner" })
      .expect(422);
  });

  it("refuses changing the owner's own role (422)", async () => {
    const community = await makeCommunity(owner);

    await request(app)
      .patch(`${BASE}/${community.slug}/members/${owner.username}`)
      .set(...bearer(owner.token))
      .send({ role: "admin" })
      .expect(422);
  });

  it("404s a role change for someone who is not a member", async () => {
    const community = await makeCommunity(owner);

    await request(app)
      .patch(`${BASE}/${community.slug}/members/${outsider.username}`)
      .set(...bearer(owner.token))
      .send({ role: "moderator" })
      .expect(404);
  });

  it("404s a role change for a username that does not exist", async () => {
    const community = await makeCommunity(owner);

    await request(app)
      .patch(`${BASE}/${community.slug}/members/nosuchuserxyz`)
      .set(...bearer(owner.token))
      .send({ role: "moderator" })
      .expect(404);
  });
});

/* ══ Member removal ══════════════════════════════════════════════════════ */

describe("Member removal", () => {
  it("removes a member and moves the counter", async () => {
    const community = await makeCommunity(owner);
    const target = await createUser();
    await seatMember(community.slug, owner, target, "member");

    expect(await counters(community.id)).toMatchObject({ counter: 2, rows: 2 });

    await request(app)
      .delete(`${BASE}/${community.slug}/members/${target.username}`)
      .set(...bearer(owner.token))
      .expect(200);

    expect(await counters(community.id)).toMatchObject({ counter: 1, rows: 1 });
  });

  it("404s removing someone who is not a member", async () => {
    const community = await makeCommunity(owner);

    await request(app)
      .delete(`${BASE}/${community.slug}/members/${outsider.username}`)
      .set(...bearer(owner.token))
      .expect(404);
  });

  it("refuses removal of the owner (422), by anyone", async () => {
    const community = await makeCommunity(owner);
    await seatMember(community.slug, owner, admin, "admin");

    for (const actor of [owner, admin]) {
      await request(app)
        .delete(`${BASE}/${community.slug}/members/${owner.username}`)
        .set(...bearer(actor.token))
        .expect(422);
    }

    const state = await counters(community.id);
    expect(state.ownerId).toBe(owner.userId);
  });

  it("refuses an admin removing a peer admin", async () => {
    const community = await makeCommunity(owner);
    const adminA = await createUser();
    const adminB = await createUser();
    await seatMember(community.slug, owner, adminA, "admin");
    await seatMember(community.slug, owner, adminB, "admin");

    await request(app)
      .delete(`${BASE}/${community.slug}/members/${adminB.username}`)
      .set(...bearer(adminA.token))
      .expect(403);
  });

  it("lets a member remove themselves through the member route", async () => {
    const community = await makeCommunity(owner);
    const target = await createUser();
    await seatMember(community.slug, owner, target, "member");

    await request(app)
      .delete(`${BASE}/${community.slug}/members/${target.username}`)
      .set(...bearer(target.token))
      .expect(200);

    expect(await counters(community.id)).toMatchObject({ counter: 1, rows: 1 });
  });
});

/* ══ Ownership transfer (decision J7) ════════════════════════════════════ */

describe("Ownership transfer", () => {
  it("moves ownerId and both membership roles atomically", async () => {
    const community = await makeCommunity(owner);
    const successor = await createUser();
    await seatMember(community.slug, owner, successor, "member");

    await request(app)
      .post(`${BASE}/${community.slug}/transfer`)
      .set(...bearer(owner.token))
      .send({ username: successor.username })
      .expect(200);

    const state = await counters(community.id);
    expect(state.ownerId).toBe(successor.userId);

    const rows = await prisma.communityMember.findMany({
      where: { communityId: community.id },
      select: { userId: true, role: true },
    });

    expect(rows.find((r) => r.userId === successor.userId)?.role).toBe("owner");
    expect(rows.find((r) => r.userId === owner.userId)?.role).toBe("admin");
  });

  it("keeps the owner invariant: ownerId always has a membership row", async () => {
    const community = await makeCommunity(owner);
    const successor = await createUser();

    await request(app)
      .post(`${BASE}/${community.slug}/transfer`)
      .set(...bearer(owner.token))
      .send({ username: successor.username })
      .expect(200);

    const state = await counters(community.id);
    const ownerRow = await prisma.communityMember.findFirst({
      where: { communityId: community.id, userId: state.ownerId },
      select: { role: true },
    });

    expect(ownerRow).not.toBeNull();
    expect(ownerRow?.role).toBe("owner");
  });

  it("counts a non-member successor exactly once", async () => {
    const community = await makeCommunity(owner);
    const successor = await createUser();

    await request(app)
      .post(`${BASE}/${community.slug}/transfer`)
      .set(...bearer(owner.token))
      .send({ username: successor.username })
      .expect(200);

    expect(await counters(community.id)).toMatchObject({ counter: 2, rows: 2 });
  });

  it("409s transferring to the current owner", async () => {
    const community = await makeCommunity(owner);

    await request(app)
      .post(`${BASE}/${community.slug}/transfer`)
      .set(...bearer(owner.token))
      .send({ username: owner.username })
      .expect(409);
  });

  it("404s transferring to a user who does not exist", async () => {
    const community = await makeCommunity(owner);

    await request(app)
      .post(`${BASE}/${community.slug}/transfer`)
      .set(...bearer(owner.token))
      .send({ username: "nosuchuserxyz" })
      .expect(404);
  });

  it("lets the new owner act, and the old owner act only as admin", async () => {
    const community = await makeCommunity(owner);
    const successor = await createUser();
    await seatMember(community.slug, owner, successor, "member");

    await request(app)
      .post(`${BASE}/${community.slug}/transfer`)
      .set(...bearer(owner.token))
      .send({ username: successor.username })
      .expect(200);

    // The previous owner keeps admin powers…
    await request(app)
      .patch(`${BASE}/${community.slug}`)
      .set(...bearer(owner.token))
      .send({ description: "still an admin" })
      .expect(200);

    // …but can no longer transfer or delete.
    await request(app)
      .post(`${BASE}/${community.slug}/transfer`)
      .set(...bearer(owner.token))
      .send({ username: owner.username })
      .expect(403);

    await request(app)
      .delete(`${BASE}/${community.slug}`)
      .set(...bearer(successor.token))
      .expect(200);
  });
});

/* ══ Listing and projections ═════════════════════════════════════════════ */

describe("Member listing", () => {
  it("returns the cursor page shape with joined users", async () => {
    const community = await makeCommunity(owner);
    const target = await createUser();
    await seatMember(community.slug, owner, target, "member");

    const response = await request(app)
      .get(`${BASE}/${community.slug}/members`)
      .expect(200);

    expect(response.body.data).toHaveProperty("items");
    expect(response.body.data).toHaveProperty("nextCursor");

    const first = response.body.data.items[0] as Record<string, unknown>;
    expect(first).toHaveProperty("userId");
    expect(first).toHaveProperty("role");
    expect(first).toHaveProperty("joinedAt");
    expect(first.user).toHaveProperty("username");
    expect(first.user).not.toHaveProperty("email");
    expect(first.user).not.toHaveProperty("passwordHash");
  });

  it("cursor-paginates without repeating or skipping", async () => {
    const community = await makeCommunity(owner);
    for (const _ of [1, 2, 3, 4, 5]) {
      await seatMember(community.slug, owner, await createUser(), "member");
    }

    const first = await request(app)
      .get(`${BASE}/${community.slug}/members`)
      .query({ limit: 3 })
      .expect(200);

    expect(first.body.data.items).toHaveLength(3);
    expect(first.body.data.nextCursor).not.toBeNull();

    const second = await request(app)
      .get(`${BASE}/${community.slug}/members`)
      .query({ limit: 3, cursor: first.body.data.nextCursor })
      .expect(200);

    const firstIds = (first.body.data.items as { userId: string }[]).map((m) => m.userId);
    const secondIds = (second.body.data.items as { userId: string }[]).map(
      (m) => m.userId,
    );

    expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
  });

  it("serves the moderator roster the sidebar renders, owner first", async () => {
    const community = await makeCommunity(owner);
    await seatMember(community.slug, owner, admin, "admin");
    await seatMember(community.slug, owner, moderator, "moderator");
    await seatMember(community.slug, owner, plain, "member");

    const response = await request(app)
      .get(`${BASE}/${community.slug}/moderators`)
      .expect(200);

    const roles = (response.body.data.moderators as { role: string }[]).map(
      (m) => m.role,
    );
    const ids = (response.body.data.moderators as { userId: string }[]).map(
      (m) => m.userId,
    );

    expect(roles[0]).toBe("owner");
    expect(ids).toContain(admin.userId);
    expect(ids).toContain(moderator.userId);
    expect(ids).not.toContain(plain.userId);
  });

  it("matches moderatorIds on the community projection", async () => {
    const community = await makeCommunity(owner);
    await seatMember(community.slug, owner, moderator, "moderator");
    await seatMember(community.slug, owner, plain, "member");

    const detail = await request(app).get(`${BASE}/${community.slug}`).expect(200);
    const roster = await request(app)
      .get(`${BASE}/${community.slug}/moderators`)
      .expect(200);

    const fromDetail = (detail.body.data.community.moderatorIds as string[]).sort();
    const fromRoster = (roster.body.data.moderators as { userId: string }[])
      .map((m) => m.userId)
      .sort();

    expect(fromDetail).toEqual(fromRoster);
  });
});

/* ══ Blocking ════════════════════════════════════════════════════════════ */

describe("Blocked users", () => {
  it("404s the blocker's community for a blocked viewer, on every route", async () => {
    const blocked = await createUser();
    const community = await makeCommunity(owner, { visibility: "public" });

    await request(app)
      .post(`/api/v1/users/${blocked.username}/block`)
      .set(...bearer(owner.token))
      .expect(201);

    for (const call of [
      request(app).get(`${BASE}/${community.slug}`),
      request(app).get(`${BASE}/${community.slug}/members`),
      request(app).get(`${BASE}/${community.slug}/moderators`),
      request(app).post(`${BASE}/${community.slug}/join`),
    ]) {
      await call.set(...bearer(blocked.token)).expect(404);
    }
  });

  it("keeps a blocked viewer's existing membership from granting access", async () => {
    // Blocking outranks membership, the Phase 4/5 precedent.
    const blocked = await createUser();
    const community = await makeCommunity(owner, { visibility: "public" });
    await seatMember(community.slug, owner, blocked, "moderator");

    await request(app)
      .post(`/api/v1/users/${blocked.username}/block`)
      .set(...bearer(owner.token))
      .expect(201);

    await request(app)
      .get(`${BASE}/${community.slug}`)
      .set(...bearer(blocked.token))
      .expect(404);
  });
});

/* ══ Audit (decision J15) ════════════════════════════════════════════════ */

describe("Audit events", () => {
  async function actionsFor(communityId: string): Promise<string[]> {
    const rows = await prisma.auditLog.findMany({
      where: { targetId: communityId, targetType: "community" },
      select: { action: true },
    });
    return rows.map((row) => row.action);
  }

  it("records COMMUNITY_ROLE_CHANGED with the from/to roles", async () => {
    const community = await makeCommunity(owner);
    const target = await createUser();
    await seatMember(community.slug, owner, target, "member");

    await request(app)
      .patch(`${BASE}/${community.slug}/members/${target.username}`)
      .set(...bearer(owner.token))
      .send({ role: "moderator" })
      .expect(200);

    const row = await prisma.auditLog.findFirst({
      where: { targetId: community.id, action: "COMMUNITY_ROLE_CHANGED" },
      select: { metadata: true, actorId: true },
    });

    expect(row).not.toBeNull();
    expect(row?.actorId).toBe(owner.userId);
    expect(row?.metadata).toMatchObject({ from: "member", to: "moderator" });
  });

  it("records member additions and removals", async () => {
    const community = await makeCommunity(owner);
    const target = await createUser();

    await seatMember(community.slug, owner, target, "member");
    await request(app)
      .delete(`${BASE}/${community.slug}/members/${target.username}`)
      .set(...bearer(owner.token))
      .expect(200);

    const actions = await actionsFor(community.id);
    expect(actions).toContain("COMMUNITY_MEMBER_ADDED");
    expect(actions).toContain("COMMUNITY_MEMBER_REMOVED");
  });

  it("records creation, deletion, and ownership transfer", async () => {
    const community = await makeCommunity(owner);
    const successor = await createUser();

    await request(app)
      .post(`${BASE}/${community.slug}/transfer`)
      .set(...bearer(owner.token))
      .send({ username: successor.username })
      .expect(200);
    await request(app)
      .delete(`${BASE}/${community.slug}`)
      .set(...bearer(successor.token))
      .expect(200);

    const actions = await actionsFor(community.id);
    expect(actions).toContain("COMMUNITY_CREATED");
    expect(actions).toContain("COMMUNITY_OWNERSHIP_TRANSFERRED");
    expect(actions).toContain("COMMUNITY_DELETED");
  });

  it("does not audit ordinary joins and leaves", async () => {
    // High-volume ordinary activity, conferring no authority — the same call
    // Phase 4 made for follows.
    const community = await makeCommunity(owner, { visibility: "public" });
    const joiner = await createUser();

    await request(app)
      .post(`${BASE}/${community.slug}/join`)
      .set(...bearer(joiner.token))
      .expect(201);
    await request(app)
      .delete(`${BASE}/${community.slug}/leave`)
      .set(...bearer(joiner.token))
      .expect(200);

    const actions = await actionsFor(community.id);
    expect(actions).not.toContain("COMMUNITY_MEMBER_ADDED");
    expect(actions).not.toContain("COMMUNITY_MEMBER_REMOVED");
  });
});

/* ══ Concurrency ═════════════════════════════════════════════════════════ */

describe("Concurrent membership", () => {
  it("counts every one of many simultaneous distinct joins", async () => {
    const community = await makeCommunity(owner, { visibility: "public" });
    const joiners = await Promise.all(Array.from({ length: 6 }, () => createUser()));

    const results = await Promise.all(
      joiners.map((joiner) =>
        request(app)
          .post(`${BASE}/${community.slug}/join`)
          .set(...bearer(joiner.token)),
      ),
    );

    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(await counters(community.id)).toMatchObject({ counter: 7, rows: 7 });
  });

  it("commits exactly one of many simultaneous identical joins", async () => {
    const community = await makeCommunity(owner, { visibility: "public" });
    const joiner = await createUser();

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app)
          .post(`${BASE}/${community.slug}/join`)
          .set(...bearer(joiner.token)),
      ),
    );

    // The unique constraint is the arbiter: one insert commits, the rest raise
    // P2002 and roll back — taking their increments with them.
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    expect(await counters(community.id)).toMatchObject({ counter: 2, rows: 2 });
  });

  it("never drives the counter negative under interleaved join and leave", async () => {
    const community = await makeCommunity(owner, { visibility: "public" });
    const joiner = await createUser();

    await request(app)
      .post(`${BASE}/${community.slug}/join`)
      .set(...bearer(joiner.token))
      .expect(201);

    await Promise.all([
      ...Array.from({ length: 5 }, () =>
        request(app)
          .delete(`${BASE}/${community.slug}/leave`)
          .set(...bearer(joiner.token)),
      ),
      ...Array.from({ length: 5 }, () =>
        request(app)
          .post(`${BASE}/${community.slug}/join`)
          .set(...bearer(joiner.token)),
      ),
    ]);

    const state = await counters(community.id);
    expect(state.counter).toBeGreaterThanOrEqual(0);
    expect(state.counter).toBe(state.rows);
  });

  it("keeps the counter equal to the rows after concurrent removals", async () => {
    const community = await makeCommunity(owner, { visibility: "public" });
    const joiners = await Promise.all(Array.from({ length: 4 }, () => createUser()));

    for (const joiner of joiners) {
      await request(app)
        .post(`${BASE}/${community.slug}/join`)
        .set(...bearer(joiner.token))
        .expect(201);
    }

    await Promise.all(
      joiners.slice(0, 2).map((joiner) =>
        request(app)
          .delete(`${BASE}/${community.slug}/members/${joiner.username}`)
          .set(...bearer(owner.token)),
      ),
    );

    const state = await counters(community.id);
    expect(state.counter).toBe(state.rows);
  });
});
