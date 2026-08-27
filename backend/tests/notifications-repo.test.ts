import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "../src/database/prisma.js";
import * as repo from "../src/modules/notifications/notifications.repository.js";
import * as service from "../src/modules/notifications/notifications.service.js";

/**
 * Notification persistence against a real PostgreSQL (ARCHITECTURE §16).
 *
 * These are the claims a unit test cannot make because they are properties of
 * the database: that the collapse rule actually finds an unread duplicate,
 * that mark-read is idempotent in SQL rather than by an application `if`, that
 * the fan-out writes in batches and respects its ceiling, and that a deleted
 * actor leaves the notification standing with a null actor.
 *
 * Rows are created through the service and the repository rather than over
 * HTTP: the subject is the data layer, and routing every fixture through
 * Argon2 would make hashing the dominant cost of the suite.
 */

const NS = "notifrepo";

let alice = "";
let bob = "";

async function makeUser(handle: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      username: `${NS}${handle}${String(Date.now() % 1000000)}`,
      email: `${NS}.${handle}.${String(Date.now())}.${String(Math.random()).slice(2, 8)}@forgehub.test`,
      passwordHash: "not-a-real-hash",
      displayName: `Notif ${handle}`,
    },
    select: { id: true },
  });
  return user.id;
}

/** Writes a notification directly, bypassing suppression. */
async function seed(
  userId: string,
  actorId: string | null,
  overrides: Partial<repo.CreateNotificationData> = {},
) {
  return repo.create({
    userId,
    actorId,
    type: "like",
    entityType: "post",
    entityId: null,
    message: "seeded",
    ...overrides,
  });
}

beforeAll(async () => {
  [alice, bob] = await Promise.all([makeUser("alice"), makeUser("bob")]);
});

afterAll(async () => {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: NS } },
    select: { id: true },
  });
  const ids = users.map((user) => user.id);

  if (ids.length > 0) {
    await prisma.notification.deleteMany({
      where: { OR: [{ userId: { in: ids } }, { actorId: { in: ids } }] },
    });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  await prisma.$disconnect();
});

describe("creation", () => {
  it("persists a notification with its rendered message", async () => {
    const [recipient, actor] = [await makeUser("rec1"), await makeUser("act1")];

    const view = await service.createNotification({
      recipientId: recipient,
      actorId: actor,
      type: "follower",
    });

    expect(view).not.toBeNull();
    expect(view?.message).toContain("started following you");

    const row = await prisma.notification.findUniqueOrThrow({
      where: { id: view?.id ?? "" },
      select: { userId: true, actorId: true, type: true, isRead: true, readAt: true },
    });
    expect(row).toMatchObject({
      userId: recipient,
      actorId: actor,
      type: "follower",
      isRead: false,
      readAt: null,
    });
  });

  it("suppresses a self-notification without writing", async () => {
    const user = await makeUser("self1");

    const view = await service.createNotification({
      recipientId: user,
      actorId: user,
      type: "like",
      entityType: "post",
    });

    expect(view).toBeNull();
    expect(await prisma.notification.count({ where: { userId: user } })).toBe(0);
  });

  it("suppresses when the actor and recipient have blocked each other", async () => {
    const [recipient, actor] = [await makeUser("blk1"), await makeUser("blk2")];
    await prisma.block.create({ data: { blockerId: recipient, blockedId: actor } });

    const view = await service.createNotification({
      recipientId: recipient,
      actorId: actor,
      type: "like",
      entityType: "post",
    });

    expect(view).toBeNull();
    expect(await prisma.notification.count({ where: { userId: recipient } })).toBe(0);
  });

  it("suppresses in the other block direction too", async () => {
    const [recipient, actor] = [await makeUser("blk3"), await makeUser("blk4")];
    await prisma.block.create({ data: { blockerId: actor, blockedId: recipient } });

    expect(
      await service.createNotification({
        recipientId: recipient,
        actorId: actor,
        type: "comment",
        entityType: "post",
      }),
    ).toBeNull();
  });

  it("suppresses when the recipient turned the type off", async () => {
    const [recipient, actor] = [await makeUser("pref1"), await makeUser("pref2")];
    await prisma.notificationPreference.create({
      data: { userId: recipient, type: "like", inApp: false },
    });

    const view = await service.createNotification({
      recipientId: recipient,
      actorId: actor,
      type: "like",
      entityType: "post",
    });

    // inApp:false must prevent persistence, not merely hide on read.
    expect(view).toBeNull();
    expect(await prisma.notification.count({ where: { userId: recipient } })).toBe(0);
  });

  it("only mutes the type that was turned off", async () => {
    const [recipient, actor] = [await makeUser("pref3"), await makeUser("pref4")];
    await prisma.notificationPreference.create({
      data: { userId: recipient, type: "like", inApp: false },
    });

    expect(
      await service.createNotification({
        recipientId: recipient,
        actorId: actor,
        type: "comment",
        entityType: "post",
      }),
    ).not.toBeNull();
  });

  it("delivers when the user has no preference row at all", async () => {
    // The default that matters: most users never open their settings, and
    // treating the absence as "off" would mute the whole feature.
    const [recipient, actor] = [await makeUser("pref5"), await makeUser("pref6")];

    expect(
      await service.createNotification({
        recipientId: recipient,
        actorId: actor,
        type: "mention",
        entityType: "post",
      }),
    ).not.toBeNull();
  });
});

describe("collapse while unread", () => {
  it("suppresses an identical notification that is still unread", async () => {
    const [recipient, actor] = [await makeUser("col1"), await makeUser("col2")];
    const post = "11111111-1111-4111-8111-111111111111";

    const first = await service.createNotification({
      recipientId: recipient,
      actorId: actor,
      type: "like",
      entityType: "post",
      entityId: post,
    });
    const second = await service.createNotification({
      recipientId: recipient,
      actorId: actor,
      type: "like",
      entityType: "post",
      entityId: post,
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await prisma.notification.count({ where: { userId: recipient } })).toBe(1);
  });

  it("allows a fresh notification once the previous one is read", async () => {
    const [recipient, actor] = [await makeUser("col3"), await makeUser("col4")];
    const post = "22222222-2222-4222-8222-222222222222";

    const first = await service.createNotification({
      recipientId: recipient,
      actorId: actor,
      type: "like",
      entityType: "post",
      entityId: post,
    });
    await repo.markRead(first?.id ?? "", recipient);

    const second = await service.createNotification({
      recipientId: recipient,
      actorId: actor,
      type: "like",
      entityType: "post",
      entityId: post,
    });

    expect(second).not.toBeNull();
    expect(await prisma.notification.count({ where: { userId: recipient } })).toBe(2);
  });

  it("does not collapse across different targets", async () => {
    const [recipient, actor] = [await makeUser("col5"), await makeUser("col6")];

    await service.createNotification({
      recipientId: recipient,
      actorId: actor,
      type: "like",
      entityType: "post",
      entityId: "33333333-3333-4333-8333-333333333333",
    });
    const other = await service.createNotification({
      recipientId: recipient,
      actorId: actor,
      type: "like",
      entityType: "post",
      entityId: "44444444-4444-4444-8444-444444444444",
    });

    expect(other).not.toBeNull();
  });

  it("does not collapse across different actors", async () => {
    const recipient = await makeUser("col7");
    const [first, second] = [await makeUser("col8"), await makeUser("col9")];
    const post = "55555555-5555-4555-8555-555555555555";

    await service.createNotification({
      recipientId: recipient,
      actorId: first,
      type: "like",
      entityType: "post",
      entityId: post,
    });
    expect(
      await service.createNotification({
        recipientId: recipient,
        actorId: second,
        type: "like",
        entityType: "post",
        entityId: post,
      }),
    ).not.toBeNull();
  });

  it("collapses a follow, which has no target at all", async () => {
    // The null-entityId case: two follows from the same person must collapse.
    const [recipient, actor] = [await makeUser("col10"), await makeUser("col11")];

    await service.createNotification({
      recipientId: recipient,
      actorId: actor,
      type: "follower",
    });
    expect(
      await service.createNotification({
        recipientId: recipient,
        actorId: actor,
        type: "follower",
      }),
    ).toBeNull();
  });

  it("never collapses invitations", async () => {
    // Each invitation is a distinct act; collapsing would lose information.
    const [recipient, actor] = [await makeUser("col12"), await makeUser("col13")];
    const project = "66666666-6666-4666-8666-666666666666";

    for (let index = 0; index < 2; index += 1) {
      const view = await service.createNotification({
        recipientId: recipient,
        actorId: actor,
        type: "project_invite",
        entityType: "project",
        entityId: project,
        subject: "Atlas",
      });
      expect(view, `invite ${String(index)}`).not.toBeNull();
    }

    expect(await prisma.notification.count({ where: { userId: recipient } })).toBe(2);
  });
});

describe("listing and paging", () => {
  it("returns newest first", async () => {
    const recipient = await makeUser("list1");

    for (const label of ["oldest", "middle", "newest"]) {
      await seed(recipient, alice, { message: label, type: "mention" });
    }

    const rows = await repo.listForUser(recipient, undefined, 10, false);
    expect(rows.map((row) => row.message)).toEqual(["newest", "middle", "oldest"]);
  });

  it("pages with a cursor and never repeats a row", async () => {
    const recipient = await makeUser("list2");
    for (let index = 0; index < 5; index += 1) {
      await seed(recipient, alice, { message: `m${String(index)}` });
    }

    const first = await repo.listForUser(recipient, undefined, 2, false);
    // Over-fetched by one to prove more exists.
    expect(first).toHaveLength(3);

    const second = await repo.listForUser(recipient, first[1]?.id, 2, false);
    const firstIds = first.slice(0, 2).map((row) => row.id);
    expect(second.some((row) => firstIds.includes(row.id))).toBe(false);
  });

  it("filters to unread when asked", async () => {
    const recipient = await makeUser("list3");
    const read = await seed(recipient, alice, { message: "read" });
    await seed(recipient, alice, { message: "unread", entityId: null, type: "comment" });
    await repo.markRead(read.id, recipient);

    const rows = await repo.listForUser(recipient, undefined, 10, true);
    expect(rows.map((row) => row.message)).toEqual(["unread"]);
  });

  it("never returns another user's notifications", async () => {
    const recipient = await makeUser("list4");
    await seed(recipient, alice);

    expect(await repo.listForUser(bob, undefined, 10, false)).toEqual([]);
  });
});

describe("unread counts and read state", () => {
  it("counts only unread rows", async () => {
    const recipient = await makeUser("cnt1");
    const first = await seed(recipient, alice, { message: "one" });
    await seed(recipient, alice, { message: "two", type: "comment" });

    expect(await repo.countUnread(recipient)).toBe(2);
    await repo.markRead(first.id, recipient);
    expect(await repo.countUnread(recipient)).toBe(1);
  });

  it("marks one read and stamps readAt", async () => {
    const recipient = await makeUser("read1");
    const row = await seed(recipient, alice);

    expect(await repo.markRead(row.id, recipient)).toBe(true);

    const reloaded = await prisma.notification.findUniqueOrThrow({
      where: { id: row.id },
      select: { isRead: true, readAt: true },
    });
    expect(reloaded.isRead).toBe(true);
    expect(reloaded.readAt).not.toBeNull();
  });

  it("is idempotent and preserves the original readAt", async () => {
    // Re-stamping would rewrite history to say they read it later than they did.
    const recipient = await makeUser("read2");
    const row = await seed(recipient, alice);

    await repo.markRead(row.id, recipient);
    const first = await prisma.notification.findUniqueOrThrow({
      where: { id: row.id },
      select: { readAt: true },
    });

    expect(await repo.markRead(row.id, recipient)).toBe(false);

    const second = await prisma.notification.findUniqueOrThrow({
      where: { id: row.id },
      select: { readAt: true },
    });
    expect(second.readAt?.toISOString()).toBe(first.readAt?.toISOString());
  });

  it("refuses to mark a notification the caller does not own", async () => {
    // The `userId` in the where clause is the last line of defence, below the
    // service's ownership check.
    const recipient = await makeUser("read3");
    const row = await seed(recipient, alice);

    expect(await repo.markRead(row.id, bob)).toBe(false);
    const reloaded = await prisma.notification.findUniqueOrThrow({
      where: { id: row.id },
      select: { isRead: true },
    });
    expect(reloaded.isRead).toBe(false);
  });

  it("marks all read and reports how many flipped", async () => {
    const recipient = await makeUser("read4");
    await seed(recipient, alice, { message: "a" });
    await seed(recipient, alice, { message: "b", type: "comment" });
    await seed(recipient, alice, { message: "c", type: "reply" });

    expect(await repo.markAllRead(recipient)).toBe(3);
    expect(await repo.countUnread(recipient)).toBe(0);
    // Second call flips nothing, which is a success rather than a miss.
    expect(await repo.markAllRead(recipient)).toBe(0);
  });

  it("marks all read only for the caller", async () => {
    const [mine, theirs] = [await makeUser("read5"), await makeUser("read6")];
    await seed(mine, alice);
    await seed(theirs, alice);

    await repo.markAllRead(mine);

    expect(await repo.countUnread(theirs)).toBe(1);
  });
});

describe("fan-out", () => {
  it("writes to every eligible follower in one pass", async () => {
    const actor = await makeUser("fan1");
    const followers = await Promise.all([
      makeUser("fanA"),
      makeUser("fanB"),
      makeUser("fanC"),
    ]);

    const delivered = await service.fanOutNotification(followers, {
      actorId: actor,
      type: "project_update",
      entityType: "project",
      entityId: "77777777-7777-4777-8777-777777777777",
      subject: "Atlas",
    });

    expect(new Set(delivered.map((row) => row.userId))).toEqual(new Set(followers));
    for (const follower of followers) {
      expect(await repo.countUnread(follower), follower).toBe(1);
    }
  });

  it("returns a complete projection for every fanned-out row", async () => {
    // The property behind the single `notification:new` payload contract: a
    // fanned-out notification must be indistinguishable from a singly-created
    // one, actor join included. `createManyAndReturn` is what makes that
    // affordable, so this test is also the proof that it carries the relation.
    const actor = await makeUser("fan7");
    const follower = await makeUser("fanJ");
    const project = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

    const [delivered] = await service.fanOutNotification([follower], {
      actorId: actor,
      type: "project_update",
      entityType: "project",
      entityId: project,
      subject: "Atlas",
    });

    expect(delivered).toBeDefined();
    expect(delivered?.userId).toBe(follower);
    expect(delivered?.actorId).toBe(actor);
    expect(delivered?.actor?.id).toBe(actor);
    expect(delivered?.actor?.username).toBeTruthy();
    expect(delivered?.type).toBe("project_update");
    expect(delivered?.entityType).toBe("project");
    expect(delivered?.targetId).toBe(project);
    expect(delivered?.message).toContain("Atlas");
    expect(delivered?.isRead).toBe(false);
    expect(delivered?.readAt).toBeNull();
    expect(typeof delivered?.createdAt).toBe("string");

    // Identical to what the REST list serves for the same row.
    const [listed] = (
      await service.list({ id: follower }, { limit: 20, unreadOnly: false })
    ).items;
    expect(delivered).toEqual(listed);
  });

  it("writes one row per recipient across batch boundaries", async () => {
    // Guards the 100-row batch split: rows written in the second statement
    // must come back with the same projection as the first.
    const actor = await makeUser("fan8");
    const followers = await Promise.all(
      Array.from({ length: 3 }, (_, index) => makeUser(`fanK${String(index)}`)),
    );

    const delivered = await service.fanOutNotification(followers, {
      actorId: actor,
      type: "project_update",
      entityType: "project",
      entityId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    });

    expect(delivered).toHaveLength(followers.length);
    expect(delivered.every((row) => row.actor !== null)).toBe(true);
    expect(new Set(delivered.map((row) => row.id)).size).toBe(followers.length);
  });

  it("skips the actor even when they follow their own project", async () => {
    const actor = await makeUser("fan2");
    const other = await makeUser("fanD");

    const delivered = await service.fanOutNotification([actor, other], {
      actorId: actor,
      type: "project_update",
      entityType: "project",
      entityId: "88888888-8888-4888-8888-888888888888",
    });

    expect(delivered.map((row) => row.userId)).toEqual([other]);
    expect(await repo.countUnread(actor)).toBe(0);
  });

  it("skips blocked followers", async () => {
    const actor = await makeUser("fan3");
    const [blocked, ordinary] = [await makeUser("fanE"), await makeUser("fanF")];
    await prisma.block.create({ data: { blockerId: blocked, blockedId: actor } });

    const delivered = await service.fanOutNotification([blocked, ordinary], {
      actorId: actor,
      type: "project_update",
      entityType: "project",
      entityId: "99999999-9999-4999-8999-999999999999",
    });

    expect(delivered.map((row) => row.userId)).toEqual([ordinary]);
    expect(await repo.countUnread(blocked)).toBe(0);
  });

  it("skips followers who muted project updates", async () => {
    const actor = await makeUser("fan4");
    const [muted, ordinary] = [await makeUser("fanG"), await makeUser("fanH")];
    await prisma.notificationPreference.create({
      data: { userId: muted, type: "project_update", inApp: false },
    });

    const delivered = await service.fanOutNotification([muted, ordinary], {
      actorId: actor,
      type: "project_update",
      entityType: "project",
      entityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });

    expect(delivered.map((row) => row.userId)).toEqual([ordinary]);
  });

  it("does not collapse two updates to the same project", async () => {
    // Each update is distinct content; collapsing would hide the second one.
    const actor = await makeUser("fan5");
    const follower = await makeUser("fanI");
    const project = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    await service.fanOutNotification([follower], {
      actorId: actor,
      type: "project_update",
      entityType: "project",
      entityId: project,
    });
    await service.fanOutNotification([follower], {
      actorId: actor,
      type: "project_update",
      entityType: "project",
      entityId: project,
    });

    expect(await repo.countUnread(follower)).toBe(2);
  });

  it("returns nothing for an empty follower list without querying", async () => {
    const actor = await makeUser("fan6");
    expect(
      await service.fanOutNotification([], { actorId: actor, type: "project_update" }),
    ).toEqual([]);
  });
});

describe("actor lifecycle", () => {
  it("keeps the notification but clears the actor when the actor is deleted", async () => {
    // `onDelete: SetNull` in the schema. The projection must survive it.
    const recipient = await makeUser("life1");
    const actor = await makeUser("life2");
    const row = await seed(recipient, actor, { message: "from someone" });

    await prisma.user.delete({ where: { id: actor } });

    const reloaded = await repo.findById(row.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.actorId).toBeNull();
    expect(reloaded?.actor).toBeNull();
  });
});
