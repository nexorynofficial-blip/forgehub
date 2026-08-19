import { PrismaClient, Prisma, ProjectMemberRole, CommunityRole } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Integration tests against a real PostgreSQL instance.
 *
 * These assert *database-level* guarantees — unique constraints, foreign
 * keys, cascade/restrict behavior. Enforcing them in application code alone
 * would leave the data open to corruption from any other client, so the
 * point is to prove the constraints exist in the schema itself.
 *
 * Requires `docker compose up -d postgres` and an applied migration.
 * Every row created here is namespaced and removed in `afterAll`.
 */

const prisma = new PrismaClient();

/** Namespacing keeps this suite from colliding with seeded development data. */
const NS = "dbtest";
const created = {
  userIds: [] as string[],
  projectIds: [] as string[],
  communityIds: [] as string[],
};

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${NS}_${prefix}_${counter}_${Date.now()}`;
}

async function makeUser(): Promise<string> {
  const handle = unique("user");
  const user = await prisma.user.create({
    data: {
      email: `${handle}@example.test`,
      username: handle,
      displayName: "DB Test User",
    },
  });
  created.userIds.push(user.id);
  return user.id;
}

async function makeProject(ownerId: string): Promise<string> {
  const project = await prisma.project.create({
    data: { slug: unique("project"), ownerId, title: "DB Test Project" },
  });
  created.projectIds.push(project.id);
  return project.id;
}

async function makeCommunity(ownerId: string): Promise<string> {
  const community = await prisma.community.create({
    data: {
      slug: unique("community"),
      name: "DB Test Community",
      category: "Testing",
      ownerId,
    },
  });
  created.communityIds.push(community.id);
  return community.id;
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  // Order matters: posts/communities/projects hold Restrict FKs onto users,
  // so they must go first. Their own children cascade.
  await prisma.post.deleteMany({ where: { author: { username: { startsWith: NS } } } });
  await prisma.community.deleteMany({ where: { id: { in: created.communityIds } } });
  await prisma.project.deleteMany({ where: { id: { in: created.projectIds } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: NS } } });
  // The achievement catalog has no user root to cascade from — remove the
  // test row explicitly so it cannot leak into seeded development data.
  await prisma.achievement.deleteMany({ where: { slug: { startsWith: NS } } });
  await prisma.$disconnect();
});

describe("Schema migration", () => {
  it("has applied every migration and created the expected tables", async () => {
    const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    const names = tables.map((t) => t.table_name);

    // Spot-check one table per domain rather than asserting an exact count,
    // which would break on every future migration.
    for (const expected of [
      "users",
      "profiles",
      "sessions",
      "projects",
      "project_members",
      "posts",
      "comments",
      "communities",
      "conversations",
      "messages",
      "notifications",
      "achievements",
      "reports",
      "audit_logs",
    ]) {
      expect(names).toContain(expected);
    }
  });
});

describe("User constraints", () => {
  it("creates a user with defaults applied", async () => {
    const id = await makeUser();
    const user = await prisma.user.findUniqueOrThrow({ where: { id } });

    expect(user.role).toBe("member");
    expect(user.status).toBe("active");
    expect(user.emailVerified).toBe(false);
    expect(user.xp).toBe(0);
    expect(user.deletedAt).toBeNull();
  });

  it("rejects a duplicate email", async () => {
    const handle = unique("dupemail");
    await prisma.user.create({
      data: { email: `${handle}@example.test`, username: handle, displayName: "A" },
    });
    created.userIds.push(handle);

    await expect(
      prisma.user.create({
        data: {
          email: `${handle}@example.test`,
          username: `${handle}_other`,
          displayName: "B",
        },
      }),
    ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);
  });

  it("rejects a duplicate username", async () => {
    const handle = unique("dupname");
    await prisma.user.create({
      data: { email: `${handle}@example.test`, username: handle, displayName: "A" },
    });

    await expect(
      prisma.user.create({
        data: {
          email: `${handle}_other@example.test`,
          username: handle,
          displayName: "B",
        },
      }),
    ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);
  });

  it("cascades profile deletion with the user", async () => {
    const id = await makeUser();
    await prisma.profile.create({ data: { userId: id, bio: "temp" } });

    await prisma.user.delete({ where: { id } });

    expect(await prisma.profile.findUnique({ where: { userId: id } })).toBeNull();
  });
});

describe("Follow constraints", () => {
  it("prevents duplicate follows", async () => {
    const a = await makeUser();
    const b = await makeUser();

    await prisma.follow.create({ data: { followerId: a, followingId: b } });

    await expect(
      prisma.follow.create({ data: { followerId: a, followingId: b } }),
    ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);
  });

  it("allows the reverse direction as a separate relationship", async () => {
    const a = await makeUser();
    const b = await makeUser();

    await prisma.follow.create({ data: { followerId: a, followingId: b } });
    const reverse = await prisma.follow.create({
      data: { followerId: b, followingId: a },
    });

    expect(reverse.id).toBeDefined();
  });

  it("rejects a follow referencing a non-existent user", async () => {
    const a = await makeUser();

    await expect(
      prisma.follow.create({
        data: { followerId: a, followingId: "00000000-0000-4000-9999-999999999999" },
      }),
    ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);
  });
});

describe("Project relationships", () => {
  it("links a project to its owner and members", async () => {
    const ownerId = await makeUser();
    const projectId = await makeProject(ownerId);

    await prisma.projectMember.create({
      data: { projectId, userId: ownerId, role: ProjectMemberRole.owner },
    });

    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      include: { owner: true, members: true },
    });

    expect(project.owner.id).toBe(ownerId);
    expect(project.members).toHaveLength(1);
    expect(project.members[0]?.role).toBe("owner");
  });

  it("prevents duplicate project memberships", async () => {
    const ownerId = await makeUser();
    const projectId = await makeProject(ownerId);

    await prisma.projectMember.create({ data: { projectId, userId: ownerId } });

    await expect(
      prisma.projectMember.create({ data: { projectId, userId: ownerId } }),
    ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);
  });

  it("cascades milestones and members when a project is deleted", async () => {
    const ownerId = await makeUser();
    const projectId = await makeProject(ownerId);
    await prisma.projectMilestone.create({ data: { projectId, title: "M1" } });
    await prisma.projectMember.create({ data: { projectId, userId: ownerId } });

    await prisma.project.delete({ where: { id: projectId } });

    expect(await prisma.projectMilestone.count({ where: { projectId } })).toBe(0);
    expect(await prisma.projectMember.count({ where: { projectId } })).toBe(0);
  });

  it("refuses to delete a user who still owns a project", async () => {
    const ownerId = await makeUser();
    await makeProject(ownerId);

    // onDelete: Restrict — accounts are soft-deleted, never hard-deleted out
    // from under their content.
    await expect(prisma.user.delete({ where: { id: ownerId } })).rejects.toThrow(
      Prisma.PrismaClientKnownRequestError,
    );
  });
});

describe("Post and comment relationships", () => {
  it("links posts to author and project, and comments to posts", async () => {
    const authorId = await makeUser();
    const projectId = await makeProject(authorId);

    const post = await prisma.post.create({
      data: { authorId, projectId, type: "milestone", content: "Shipped" },
    });
    const comment = await prisma.comment.create({
      data: { postId: post.id, authorId, content: "Nice" },
    });
    await prisma.comment.create({
      data: {
        postId: post.id,
        authorId,
        parentCommentId: comment.id,
        content: "Thanks",
      },
    });

    const loaded = await prisma.post.findUniqueOrThrow({
      where: { id: post.id },
      include: { author: true, project: true, comments: { include: { replies: true } } },
    });

    expect(loaded.author.id).toBe(authorId);
    expect(loaded.project?.id).toBe(projectId);
    expect(loaded.comments).toHaveLength(2);

    const root = loaded.comments.find((c) => c.parentCommentId === null);
    expect(root?.replies).toHaveLength(1);
  });

  it("prevents duplicate likes and bookmarks", async () => {
    const userId = await makeUser();
    const post = await prisma.post.create({
      data: { authorId: userId, content: "Hello" },
    });

    await prisma.postLike.create({ data: { postId: post.id, userId } });
    await expect(
      prisma.postLike.create({ data: { postId: post.id, userId } }),
    ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);

    await prisma.bookmark.create({ data: { postId: post.id, userId } });
    await expect(
      prisma.bookmark.create({ data: { postId: post.id, userId } }),
    ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);
  });

  it("cascades comments and replies when a post is deleted", async () => {
    const userId = await makeUser();
    const post = await prisma.post.create({
      data: { authorId: userId, content: "Temp" },
    });
    const root = await prisma.comment.create({
      data: { postId: post.id, authorId: userId, content: "Root" },
    });
    await prisma.comment.create({
      data: {
        postId: post.id,
        authorId: userId,
        parentCommentId: root.id,
        content: "Reply",
      },
    });

    await prisma.post.delete({ where: { id: post.id } });

    expect(await prisma.comment.count({ where: { postId: post.id } })).toBe(0);
  });

  it("enforces one poll vote per user per poll, not per option", async () => {
    const userId = await makeUser();
    const post = await prisma.post.create({
      data: { authorId: userId, type: "poll", content: "Which?" },
    });
    const poll = await prisma.poll.create({
      data: {
        postId: post.id,
        question: "Which one?",
        options: {
          create: [
            { label: "A", position: 0 },
            { label: "B", position: 1 },
          ],
        },
      },
      include: { options: true },
    });

    const [optionA, optionB] = poll.options;
    await prisma.pollVote.create({
      data: { pollId: poll.id, optionId: optionA!.id, userId },
    });

    // Voting for a *different* option in the same poll must still be rejected.
    await expect(
      prisma.pollVote.create({
        data: { pollId: poll.id, optionId: optionB!.id, userId },
      }),
    ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);
  });
});

describe("Community relationships", () => {
  it("links a community to owner, members, rules, and events", async () => {
    const ownerId = await makeUser();
    const communityId = await makeCommunity(ownerId);

    await prisma.communityMember.create({
      data: { communityId, userId: ownerId, role: CommunityRole.owner },
    });
    await prisma.communityRule.create({ data: { communityId, content: "Be kind" } });
    await prisma.communityEvent.create({
      data: { communityId, title: "Demo night", startsAt: new Date() },
    });

    const community = await prisma.community.findUniqueOrThrow({
      where: { id: communityId },
      include: { owner: true, members: true, rules: true, events: true },
    });

    expect(community.owner.id).toBe(ownerId);
    expect(community.members).toHaveLength(1);
    expect(community.rules).toHaveLength(1);
    expect(community.events).toHaveLength(1);
  });

  it("prevents duplicate community memberships", async () => {
    const ownerId = await makeUser();
    const communityId = await makeCommunity(ownerId);

    await prisma.communityMember.create({ data: { communityId, userId: ownerId } });

    await expect(
      prisma.communityMember.create({ data: { communityId, userId: ownerId } }),
    ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);
  });
});

describe("Messaging relationships", () => {
  it("prevents duplicate conversation memberships", async () => {
    const userId = await makeUser();
    const conversation = await prisma.conversation.create({ data: {} });

    await prisma.conversationMember.create({
      data: { conversationId: conversation.id, userId },
    });

    await expect(
      prisma.conversationMember.create({
        data: { conversationId: conversation.id, userId },
      }),
    ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);

    await prisma.conversation.delete({ where: { id: conversation.id } });
  });

  it("allows distinct emoji per user but rejects the same one twice", async () => {
    const userId = await makeUser();
    const conversation = await prisma.conversation.create({ data: {} });
    const message = await prisma.message.create({
      data: { conversationId: conversation.id, senderId: userId, content: "hi" },
    });

    await prisma.messageReaction.create({
      data: { messageId: message.id, userId, emoji: "👍" },
    });
    await prisma.messageReaction.create({
      data: { messageId: message.id, userId, emoji: "🎉" },
    });

    await expect(
      prisma.messageReaction.create({
        data: { messageId: message.id, userId, emoji: "👍" },
      }),
    ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);

    await prisma.conversation.delete({ where: { id: conversation.id } });
  });
});

describe("Notifications", () => {
  it("stores a polymorphic target and cascades with the recipient", async () => {
    const recipientId = await makeUser();
    const actorId = await makeUser();

    await prisma.notification.create({
      data: {
        userId: recipientId,
        actorId,
        type: "like",
        entityType: "post",
        entityId: "00000000-0000-4000-7777-000000000001",
        message: "Someone liked your post",
      },
    });

    expect(await prisma.notification.count({ where: { userId: recipientId } })).toBe(1);

    await prisma.user.delete({ where: { id: recipientId } });
    expect(await prisma.notification.count({ where: { userId: recipientId } })).toBe(0);
  });

  it("keeps the notification but clears the actor when the actor is deleted", async () => {
    const recipientId = await makeUser();
    const actorId = await makeUser();

    const notification = await prisma.notification.create({
      data: { userId: recipientId, actorId, type: "follower", message: "Followed you" },
    });

    await prisma.user.delete({ where: { id: actorId } });

    // onDelete: SetNull — the recipient should not lose their history just
    // because the other account went away.
    const reloaded = await prisma.notification.findUnique({
      where: { id: notification.id },
    });
    expect(reloaded).not.toBeNull();
    expect(reloaded?.actorId).toBeNull();
  });
});

describe("Achievements", () => {
  it("prevents awarding the same achievement twice", async () => {
    const userId = await makeUser();
    const achievement = await prisma.achievement.upsert({
      where: { slug: `${NS}-achievement` },
      update: {},
      create: { slug: `${NS}-achievement`, name: "Test Achievement" },
    });

    await prisma.userAchievement.create({
      data: { userId, achievementId: achievement.id },
    });

    await expect(
      prisma.userAchievement.create({
        data: { userId, achievementId: achievement.id },
      }),
    ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);
  });
});

describe("Audit and moderation retention", () => {
  it("retains audit logs after the actor is deleted", async () => {
    const actorId = await makeUser();

    const log = await prisma.auditLog.create({
      data: { actorId, action: "USER_LOGIN", targetType: "user", targetId: actorId },
    });

    await prisma.user.delete({ where: { id: actorId } });

    // The trail must survive account deletion, with the actor nulled out.
    const reloaded = await prisma.auditLog.findUnique({ where: { id: log.id } });
    expect(reloaded).not.toBeNull();
    expect(reloaded?.actorId).toBeNull();
    expect(reloaded?.action).toBe("USER_LOGIN");

    await prisma.auditLog.delete({ where: { id: log.id } });
  });

  it("refuses to delete a user who has filed a report", async () => {
    const reporterId = await makeUser();
    const report = await prisma.report.create({
      data: {
        reporterId,
        targetType: "post",
        targetId: "00000000-0000-4000-7777-000000000002",
        reason: "spam",
      },
    });

    await expect(prisma.user.delete({ where: { id: reporterId } })).rejects.toThrow(
      Prisma.PrismaClientKnownRequestError,
    );

    await prisma.report.delete({ where: { id: report.id } });
  });
});
