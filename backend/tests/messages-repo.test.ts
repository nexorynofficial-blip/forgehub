import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "../src/database/prisma.js";
import * as repo from "../src/modules/messages/messages.repository.js";

/**
 * Repository behaviour against a real PostgreSQL (BACKEND_ARCHITECTURE.md §13).
 *
 * These are the claims that cannot be proved by a unit test because they are
 * properties of the *database*: that the advisory lock actually serializes a
 * concurrent pair, that the unread query counts what it says it counts, that
 * the watermark refuses to move backwards under a real concurrent update, and
 * that the reaction uniqueness constraint is the arbiter rather than an
 * application `if`.
 *
 * Rows are created directly through Prisma rather than through the API: the
 * subject here is the data layer, and going through HTTP would make an Argon2
 * hash the dominant cost of every test.
 */

const NS = "msgrepo";

let alice = "";
let bob = "";
let carol = "";

async function makeUser(handle: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      username: `${NS}${handle}${String(Date.now() % 100000)}`,
      email: `${NS}.${handle}.${String(Date.now())}@forgehub.test`,
      passwordHash: "not-a-real-hash",
      displayName: handle,
    },
    select: { id: true },
  });
  return user.id;
}

async function send(conversationId: string, senderId: string, content: string) {
  return repo.createMessage({ conversationId, senderId, content, attachments: [] });
}

beforeAll(async () => {
  [alice, bob, carol] = await Promise.all([
    makeUser("alice"),
    makeUser("bob"),
    makeUser("carol"),
  ]);
});

afterAll(async () => {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: NS } },
    select: { id: true },
  });
  const ids = users.map((user) => user.id);

  if (ids.length > 0) {
    // Conversations cascade to members, messages, attachments, and reactions,
    // so removing them first leaves nothing pointing at the users.
    const conversations = await prisma.conversation.findMany({
      where: { members: { some: { userId: { in: ids } } } },
      select: { id: true },
    });
    await prisma.conversation.deleteMany({
      where: { id: { in: conversations.map((row) => row.id) } },
    });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  await prisma.$disconnect();
});

describe("direct conversation creation", () => {
  it("creates a conversation with exactly the two members", async () => {
    const { conversation, created } = await repo.findOrCreateDirectConversation(
      alice,
      bob,
    );

    expect(created).toBe(true);
    expect(conversation.isGroup).toBe(false);
    expect(new Set(conversation.members.map((m) => m.userId))).toEqual(
      new Set([alice, bob]),
    );
  });

  it("reuses the existing conversation on a second request", async () => {
    const first = await repo.findOrCreateDirectConversation(alice, bob);
    const second = await repo.findOrCreateDirectConversation(alice, bob);

    expect(second.created).toBe(false);
    expect(second.conversation.id).toBe(first.conversation.id);
  });

  it("reuses it when the *other* party initiates", async () => {
    // The canonical sorted key is what makes this work: direction must not
    // produce a second conversation.
    const forward = await repo.findOrCreateDirectConversation(alice, bob);
    const reverse = await repo.findOrCreateDirectConversation(bob, alice);

    expect(reverse.conversation.id).toBe(forward.conversation.id);
  });

  it("creates exactly one conversation under a concurrent race", async () => {
    // The reason the advisory lock exists. Without it both transactions find
    // nothing, both insert, and the pair ends up with two conversations that
    // then split their history.
    const [x, y] = [await makeUser("racex"), await makeUser("racey")];

    const results = await Promise.all([
      repo.findOrCreateDirectConversation(x, y),
      repo.findOrCreateDirectConversation(y, x),
      repo.findOrCreateDirectConversation(x, y),
      repo.findOrCreateDirectConversation(y, x),
    ]);

    const ids = new Set(results.map((result) => result.conversation.id));
    expect(ids.size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);

    const rows = await prisma.conversation.findMany({
      where: {
        isGroup: false,
        AND: [{ members: { some: { userId: x } } }, { members: { some: { userId: y } } }],
      },
      select: { id: true },
    });
    expect(rows).toHaveLength(1);
  });

  it("keeps different pairs apart", async () => {
    const ab = await repo.findOrCreateDirectConversation(alice, bob);
    const ac = await repo.findOrCreateDirectConversation(alice, carol);

    expect(ac.conversation.id).not.toBe(ab.conversation.id);
  });

  it("does not mistake a three-member conversation for a direct one", async () => {
    // `some` alone would match a group containing both users; the `every`
    // clause plus `isGroup` is what excludes it.
    const group = await prisma.conversation.create({
      data: {
        isGroup: true,
        members: {
          create: [{ userId: alice }, { userId: bob }, { userId: carol }],
        },
      },
      select: { id: true },
    });

    const found = await repo.findDirectConversation(alice, bob);

    expect(found).not.toBeNull();
    expect(found?.id).not.toBe(group.id);
  });
});

describe("messages", () => {
  it("stamps lastMessageAt to the message's own createdAt", async () => {
    const { conversation } = await repo.findOrCreateDirectConversation(alice, carol);
    const message = await send(conversation.id, alice, "first");

    const row = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversation.id },
      select: { lastMessageAt: true },
    });

    expect(row.lastMessageAt?.toISOString()).toBe(message.createdAt.toISOString());
  });

  it("persists attachments alongside the message", async () => {
    const { conversation } = await repo.findOrCreateDirectConversation(alice, carol);

    const message = await repo.createMessage({
      conversationId: conversation.id,
      senderId: alice,
      content: "see this",
      attachments: [
        { url: "ref-1", name: "diagram.png", type: "image", sizeBytes: 1024 },
        { url: "ref-2", name: "notes.txt", type: "file" },
      ],
    });

    expect(message.attachments).toHaveLength(2);
    expect(message.attachments.map((a) => a.name).sort()).toEqual([
      "diagram.png",
      "notes.txt",
    ]);
    // Absent size stays null rather than being invented.
    expect(message.attachments.find((a) => a.name === "notes.txt")?.sizeBytes).toBeNull();
  });

  it("pages newest-first and stably", async () => {
    const [x, y] = [await makeUser("pagex"), await makeUser("pagey")];
    const { conversation } = await repo.findOrCreateDirectConversation(x, y);

    for (let index = 0; index < 7; index += 1) {
      await send(conversation.id, x, `m${String(index)}`);
    }

    const first = await repo.listMessages(conversation.id, undefined, 3);
    expect(first.slice(0, 3).map((m) => m.content)).toEqual(["m6", "m5", "m4"]);
    // Over-fetched by one to prove more exists.
    expect(first).toHaveLength(4);

    const second = await repo.listMessages(conversation.id, first[2]?.id, 3);
    expect(second.slice(0, 3).map((m) => m.content)).toEqual(["m3", "m2", "m1"]);
  });

  it("omits deleted messages from listings", async () => {
    const [x, y] = [await makeUser("delx"), await makeUser("dely")];
    const { conversation } = await repo.findOrCreateDirectConversation(x, y);

    const keep = await send(conversation.id, x, "keep");
    const drop = await send(conversation.id, x, "drop");

    expect(await repo.softDeleteMessage(drop.id, x)).toBe(true);

    const listed = await repo.listMessages(conversation.id, undefined, 10);
    expect(listed.map((m) => m.id)).toEqual([keep.id]);
  });

  it("keeps the row after a soft delete rather than destroying it", async () => {
    const [x, y] = [await makeUser("softx"), await makeUser("softy")];
    const { conversation } = await repo.findOrCreateDirectConversation(x, y);
    const message = await send(conversation.id, x, "historical record");

    await repo.softDeleteMessage(message.id, x);

    const row = await prisma.message.findUnique({
      where: { id: message.id },
      select: { content: true, deletedAt: true },
    });

    expect(row?.content).toBe("historical record");
    expect(row?.deletedAt).not.toBeNull();
  });

  it("refuses to delete a message the caller did not send", async () => {
    const [x, y] = [await makeUser("ownx"), await makeUser("owny")];
    const { conversation } = await repo.findOrCreateDirectConversation(x, y);
    const message = await send(conversation.id, x, "mine");

    // The `senderId` in the where clause is the last line of defence, below
    // the service's authorization check.
    expect(await repo.softDeleteMessage(message.id, y)).toBe(false);
  });

  it("refuses to edit a message the caller did not send", async () => {
    const [x, y] = [await makeUser("editx"), await makeUser("edity")];
    const { conversation } = await repo.findOrCreateDirectConversation(x, y);
    const message = await send(conversation.id, x, "original");

    expect(await repo.updateMessageContent(message.id, y, "hijacked")).toBeNull();

    const row = await prisma.message.findUniqueOrThrow({
      where: { id: message.id },
      select: { content: true, editedAt: true },
    });
    expect(row.content).toBe("original");
    expect(row.editedAt).toBeNull();
  });

  it("stamps editedAt on a real edit", async () => {
    const [x, y] = [await makeUser("stampx"), await makeUser("stampy")];
    const { conversation } = await repo.findOrCreateDirectConversation(x, y);
    const message = await send(conversation.id, x, "before");

    const updated = await repo.updateMessageContent(message.id, x, "after");

    expect(updated?.content).toBe("after");
    expect(updated?.editedAt).not.toBeNull();
  });
});

describe("conversation list", () => {
  it("orders by last activity, newest first", async () => {
    const owner = await makeUser("listowner");
    const [p1, p2, p3] = await Promise.all([
      makeUser("listp1"),
      makeUser("listp2"),
      makeUser("listp3"),
    ]);

    const first = await repo.findOrCreateDirectConversation(owner, p1);
    const second = await repo.findOrCreateDirectConversation(owner, p2);
    const third = await repo.findOrCreateDirectConversation(owner, p3);

    await send(first.conversation.id, owner, "a");
    await send(second.conversation.id, owner, "b");
    await send(third.conversation.id, owner, "c");
    // Re-activating the first must float it back to the top.
    await send(first.conversation.id, owner, "d");

    const rows = await repo.listConversations(owner, undefined, 10);
    const ids = rows.map((row) => row.id);

    expect(ids.slice(0, 3)).toEqual([
      first.conversation.id,
      third.conversation.id,
      second.conversation.id,
    ]);
  });

  it("sorts a never-used conversation last rather than first", async () => {
    const owner = await makeUser("nullsowner");
    const [p1, p2] = await Promise.all([makeUser("nullsp1"), makeUser("nullsp2")]);

    const used = await repo.findOrCreateDirectConversation(owner, p1);
    const unused = await repo.findOrCreateDirectConversation(owner, p2);
    await send(used.conversation.id, owner, "hello");

    const ids = (await repo.listConversations(owner, undefined, 10)).map((r) => r.id);

    expect(ids.indexOf(used.conversation.id)).toBeLessThan(
      ids.indexOf(unused.conversation.id),
    );
  });

  it("returns only conversations the user belongs to", async () => {
    const outsider = await makeUser("outsider");
    const rows = await repo.listConversations(outsider, undefined, 10);
    expect(rows).toEqual([]);
  });

  it("resolves the latest live message per conversation in one batch", async () => {
    const owner = await makeUser("latestowner");
    const [p1, p2] = await Promise.all([makeUser("latestp1"), makeUser("latestp2")]);

    const a = await repo.findOrCreateDirectConversation(owner, p1);
    const b = await repo.findOrCreateDirectConversation(owner, p2);

    await send(a.conversation.id, owner, "a-old");
    const aNew = await send(a.conversation.id, owner, "a-new");
    const bOnly = await send(b.conversation.id, owner, "b-only");

    const latest = await repo.findLatestMessages([a.conversation.id, b.conversation.id]);

    expect(latest.get(a.conversation.id)?.id).toBe(aNew.id);
    expect(latest.get(b.conversation.id)?.id).toBe(bOnly.id);
  });

  it("falls back to the previous message when the newest was deleted", async () => {
    // Why `lastMessage` cannot simply be read off `lastMessageAt`: the newest
    // message may since have been removed, and the list must not show a hole.
    const [x, y] = [await makeUser("fallx"), await makeUser("fally")];
    const { conversation } = await repo.findOrCreateDirectConversation(x, y);

    const older = await send(conversation.id, x, "older");
    const newest = await send(conversation.id, x, "newest");
    await repo.softDeleteMessage(newest.id, x);

    const latest = await repo.findLatestMessages([conversation.id]);
    expect(latest.get(conversation.id)?.id).toBe(older.id);
  });
});

describe("unread counts", () => {
  it("counts everything when the member has never read", async () => {
    const [x, y] = [await makeUser("unreadx"), await makeUser("unready")];
    const { conversation } = await repo.findOrCreateDirectConversation(x, y);

    await send(conversation.id, x, "one");
    await send(conversation.id, x, "two");

    expect(await repo.countUnreadForConversation(y, conversation.id)).toBe(2);
  });

  it("never counts your own messages against you", async () => {
    const [x, y] = [await makeUser("ownmsgx"), await makeUser("ownmsgy")];
    const { conversation } = await repo.findOrCreateDirectConversation(x, y);

    await send(conversation.id, x, "mine");
    await send(conversation.id, x, "also mine");

    expect(await repo.countUnreadForConversation(x, conversation.id)).toBe(0);
  });

  it("drops to zero after the watermark advances", async () => {
    const [x, y] = [await makeUser("markx"), await makeUser("marky")];
    const { conversation } = await repo.findOrCreateDirectConversation(x, y);

    await send(conversation.id, x, "one");
    const newest = await send(conversation.id, x, "two");

    await repo.advanceWatermark(conversation.id, y, newest.id, newest.createdAt);

    expect(await repo.countUnreadForConversation(y, conversation.id)).toBe(0);
  });

  it("counts only what arrived after the watermark", async () => {
    const [x, y] = [await makeUser("aftx"), await makeUser("afty")];
    const { conversation } = await repo.findOrCreateDirectConversation(x, y);

    const seen = await send(conversation.id, x, "seen");
    await repo.advanceWatermark(conversation.id, y, seen.id, seen.createdAt);

    await send(conversation.id, x, "new one");
    await send(conversation.id, x, "new two");

    expect(await repo.countUnreadForConversation(y, conversation.id)).toBe(2);
  });

  it("does not count deleted messages", async () => {
    const [x, y] = [await makeUser("unrdelx"), await makeUser("unrdely")];
    const { conversation } = await repo.findOrCreateDirectConversation(x, y);

    await send(conversation.id, x, "stays");
    const gone = await send(conversation.id, x, "goes");
    await repo.softDeleteMessage(gone.id, x);

    expect(await repo.countUnreadForConversation(y, conversation.id)).toBe(1);
  });

  it("batches counts across many conversations in one query", async () => {
    const owner = await makeUser("batchowner");
    const partners = await Promise.all([
      makeUser("batchp1"),
      makeUser("batchp2"),
      makeUser("batchp3"),
    ]);

    const ids: string[] = [];
    for (const [index, partner] of partners.entries()) {
      const { conversation } = await repo.findOrCreateDirectConversation(owner, partner);
      ids.push(conversation.id);
      for (let n = 0; n <= index; n += 1) {
        await send(conversation.id, partner, `m${String(n)}`);
      }
    }

    const counts = await repo.countUnread(owner, ids);

    expect(counts.get(ids[0] ?? "")).toBe(1);
    expect(counts.get(ids[1] ?? "")).toBe(2);
    expect(counts.get(ids[2] ?? "")).toBe(3);
  });

  it("returns an empty map for an empty id list without querying", async () => {
    expect(await repo.countUnread(alice, [])).toEqual(new Map());
  });
});

describe("read watermark", () => {
  it("advances forward", async () => {
    const [x, y] = [await makeUser("wmx"), await makeUser("wmy")];
    const { conversation } = await repo.findOrCreateDirectConversation(x, y);

    const first = await send(conversation.id, x, "one");
    const second = await send(conversation.id, x, "two");

    expect(
      await repo.advanceWatermark(conversation.id, y, first.id, first.createdAt),
    ).toBe(true);
    expect(
      await repo.advanceWatermark(conversation.id, y, second.id, second.createdAt),
    ).toBe(true);

    const membership = await repo.findMembership(conversation.id, y);
    expect(membership?.lastReadMessageId).toBe(second.id);
  });

  it("refuses to move backwards, in SQL", async () => {
    // The guard lives in the `where` clause, not in application code, so a
    // late-arriving request from a second device cannot win a read-modify-write.
    const [x, y] = [await makeUser("backx"), await makeUser("backy")];
    const { conversation } = await repo.findOrCreateDirectConversation(x, y);

    const first = await send(conversation.id, x, "one");
    const second = await send(conversation.id, x, "two");

    await repo.advanceWatermark(conversation.id, y, second.id, second.createdAt);
    const moved = await repo.advanceWatermark(
      conversation.id,
      y,
      first.id,
      first.createdAt,
    );

    expect(moved).toBe(false);
    const membership = await repo.findMembership(conversation.id, y);
    expect(membership?.lastReadMessageId).toBe(second.id);
  });

  it("keeps the newest watermark when devices race", async () => {
    const [x, y] = [await makeUser("racewmx"), await makeUser("racewmy")];
    const { conversation } = await repo.findOrCreateDirectConversation(x, y);

    const first = await send(conversation.id, x, "one");
    const second = await send(conversation.id, x, "two");
    const third = await send(conversation.id, x, "three");

    await Promise.all([
      repo.advanceWatermark(conversation.id, y, third.id, third.createdAt),
      repo.advanceWatermark(conversation.id, y, first.id, first.createdAt),
      repo.advanceWatermark(conversation.id, y, second.id, second.createdAt),
    ]);

    const membership = await repo.findMembership(conversation.id, y);
    expect(membership?.lastReadAt?.toISOString()).toBe(third.createdAt.toISOString());
    expect(await repo.countUnreadForConversation(y, conversation.id)).toBe(0);
  });
});

describe("reactions", () => {
  it("adds a reaction", async () => {
    const [x, y] = [await makeUser("reactx"), await makeUser("reacty")];
    const { conversation } = await repo.findOrCreateDirectConversation(x, y);
    const message = await send(conversation.id, x, "react to me");

    expect(await repo.addReaction(message.id, y, "👍")).toBe(true);

    const row = await repo.findMessageById(message.id);
    expect(row?.reactions).toEqual([{ emoji: "👍", userId: y }]);
  });

  it("treats a duplicate as already done rather than an error", async () => {
    const [x, y] = [await makeUser("dupx"), await makeUser("dupy")];
    const { conversation } = await repo.findOrCreateDirectConversation(x, y);
    const message = await send(conversation.id, x, "double tap");

    expect(await repo.addReaction(message.id, y, "🔥")).toBe(true);
    expect(await repo.addReaction(message.id, y, "🔥")).toBe(false);

    const row = await repo.findMessageById(message.id);
    expect(row?.reactions).toHaveLength(1);
  });

  it("lets the unique index arbitrate a concurrent double-tap", async () => {
    const [x, y] = [await makeUser("concx"), await makeUser("concy")];
    const { conversation } = await repo.findOrCreateDirectConversation(x, y);
    const message = await send(conversation.id, x, "fast fingers");

    const results = await Promise.all([
      repo.addReaction(message.id, y, "🎉"),
      repo.addReaction(message.id, y, "🎉"),
      repo.addReaction(message.id, y, "🎉"),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const row = await repo.findMessageById(message.id);
    expect(row?.reactions).toHaveLength(1);
  });

  it("allows different emoji from the same user", async () => {
    const [x, y] = [await makeUser("multix"), await makeUser("multiy")];
    const { conversation } = await repo.findOrCreateDirectConversation(x, y);
    const message = await send(conversation.id, x, "many feelings");

    await repo.addReaction(message.id, y, "👍");
    await repo.addReaction(message.id, y, "❤️");

    const row = await repo.findMessageById(message.id);
    expect(row?.reactions).toHaveLength(2);
  });

  it("allows the same emoji from different users", async () => {
    const [x, y] = [await makeUser("sharex"), await makeUser("sharey")];
    const { conversation } = await repo.findOrCreateDirectConversation(x, y);
    const message = await send(conversation.id, x, "agreed?");

    await repo.addReaction(message.id, x, "👍");
    await repo.addReaction(message.id, y, "👍");

    const row = await repo.findMessageById(message.id);
    expect(row?.reactions).toHaveLength(2);
  });

  it("removes only the caller's own reaction", async () => {
    const [x, y] = [await makeUser("remx"), await makeUser("remy")];
    const { conversation } = await repo.findOrCreateDirectConversation(x, y);
    const message = await send(conversation.id, x, "mixed");

    await repo.addReaction(message.id, x, "👍");
    await repo.addReaction(message.id, y, "👍");

    expect(await repo.removeReaction(message.id, y, "👍")).toBe(true);

    const row = await repo.findMessageById(message.id);
    expect(row?.reactions).toEqual([{ emoji: "👍", userId: x }]);
  });

  it("reports removing a reaction that was never there", async () => {
    const [x, y] = [await makeUser("nonex"), await makeUser("noney")];
    const { conversation } = await repo.findOrCreateDirectConversation(x, y);
    const message = await send(conversation.id, x, "untouched");

    expect(await repo.removeReaction(message.id, y, "👍")).toBe(false);
  });
});

describe("search", () => {
  it("matches case-insensitively on a fragment", async () => {
    const [x, y] = [await makeUser("srchx"), await makeUser("srchy")];
    const { conversation } = await repo.findOrCreateDirectConversation(x, y);

    await send(conversation.id, x, "Deploying the Backend tonight");
    await send(conversation.id, y, "unrelated chatter");

    const hits = await repo.searchMessages(conversation.id, "backend", undefined, 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toContain("Backend");
  });

  it("never returns messages from another conversation", async () => {
    // The property that matters most: search is scoped by conversation id in
    // the query itself, so there is no path to another thread's content.
    const owner = await makeUser("srchowner");
    const [p1, p2] = await Promise.all([makeUser("srchp1"), makeUser("srchp2")]);

    const mine = await repo.findOrCreateDirectConversation(owner, p1);
    const other = await repo.findOrCreateDirectConversation(owner, p2);

    await send(mine.conversation.id, owner, "shared secret alpha");
    await send(other.conversation.id, owner, "shared secret beta");

    const hits = await repo.searchMessages(
      mine.conversation.id,
      "shared secret",
      undefined,
      10,
    );

    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toBe("shared secret alpha");
  });

  it("excludes deleted messages", async () => {
    const [x, y] = [await makeUser("srchdelx"), await makeUser("srchdely")];
    const { conversation } = await repo.findOrCreateDirectConversation(x, y);

    const gone = await send(conversation.id, x, "findme deleted");
    await send(conversation.id, x, "findme kept");
    await repo.softDeleteMessage(gone.id, x);

    const hits = await repo.searchMessages(conversation.id, "findme", undefined, 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toBe("findme kept");
  });

  it("pages results with a cursor", async () => {
    const [x, y] = [await makeUser("srchpagex"), await makeUser("srchpagey")];
    const { conversation } = await repo.findOrCreateDirectConversation(x, y);

    for (let index = 0; index < 5; index += 1) {
      await send(conversation.id, x, `needle ${String(index)}`);
    }

    const first = await repo.searchMessages(conversation.id, "needle", undefined, 2);
    expect(first).toHaveLength(3);

    const second = await repo.searchMessages(conversation.id, "needle", first[1]?.id, 2);
    expect(second[0]?.content).toBe("needle 2");
  });
});

describe("participants", () => {
  it("lists the live members of a conversation", async () => {
    const { conversation } = await repo.findOrCreateDirectConversation(alice, bob);
    const ids = await repo.findParticipantIds(conversation.id);

    expect(new Set(ids)).toEqual(new Set([alice, bob]));
  });

  it("excludes a member who has left", async () => {
    const [x, y] = [await makeUser("leftx"), await makeUser("lefty")];
    const { conversation } = await repo.findOrCreateDirectConversation(x, y);

    await prisma.conversationMember.updateMany({
      where: { conversationId: conversation.id, userId: y },
      data: { leftAt: new Date() },
    });

    expect(await repo.findParticipantIds(conversation.id)).toEqual([x]);
    expect(await repo.findMembership(conversation.id, y)).toBeNull();
  });

  it("finds everyone the user shares a conversation with", async () => {
    const owner = await makeUser("partowner");
    const [p1, p2] = await Promise.all([makeUser("partp1"), makeUser("partp2")]);

    await repo.findOrCreateDirectConversation(owner, p1);
    await repo.findOrCreateDirectConversation(owner, p2);

    const partners = await repo.findConversationPartnerIds(owner);

    expect(new Set(partners)).toEqual(new Set([p1, p2]));
    expect(partners).not.toContain(owner);
  });
});
