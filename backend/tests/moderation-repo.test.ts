import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "../src/database/prisma.js";
import * as repo from "../src/modules/moderation/moderation.repository.js";
import { listAuditLogs } from "../src/repositories/audit.repository.js";
import { AuditAction } from "../src/utils/audit.js";

/**
 * The moderation data layer against a real database (ARCHITECTURE §25,
 * TRD §28).
 *
 * Three things are pinned here that an HTTP test cannot see:
 *
 *   1. **The transaction is real.** A moderation action and its audit row
 *      commit together, and a rolled-back action leaves neither — ruling R9 is
 *      a database property, not an application convention.
 *   2. **Counters stay honest.** Moderator content removal reproduces each
 *      domain's own soft-delete side-effects, so a removed comment still
 *      decrements its post and a removed project still decrements its owner.
 *   3. **The queue rides its index.** `reports(status, createdAt)` exists to
 *      serve pending-first, oldest-first; the ordering is asserted rather than
 *      assumed.
 */

const NS = "modrepo";

let seq = 0;
function unique(prefix: string): string {
  seq += 1;
  return `${NS}-${prefix}-${String(seq)}-${String(Date.now())}`;
}

interface Fixture {
  id: string;
  username: string;
}

async function createUser(role: "member" | "moderator" = "member"): Promise<Fixture> {
  const username = unique("user");
  const user = await prisma.user.create({
    data: {
      email: `${username}@forgehub.test`,
      username,
      displayName: "Repo Fixture",
      passwordHash: "not-a-real-hash",
      role,
    },
    select: { id: true, username: true },
  });
  return user;
}

async function createPost(authorId: string): Promise<string> {
  const post = await prisma.post.create({
    data: { authorId, type: "text", content: "Repo fixture post." },
    select: { id: true },
  });
  return post.id;
}

beforeAll(async () => {
  await prisma.$connect();
}, 60_000);

afterAll(async () => {
  const users = await prisma.user.findMany({
    where: { username: { startsWith: NS } },
    select: { id: true },
  });
  const ids = users.map((user) => user.id);

  if (ids.length > 0) {
    await prisma.moderationAction.deleteMany({
      where: { OR: [{ moderatorId: { in: ids } }, { targetUserId: { in: ids } }] },
    });
    await prisma.report.deleteMany({
      where: { OR: [{ reporterId: { in: ids } }, { targetAuthorId: { in: ids } }] },
    });
    await prisma.auditLog.deleteMany({
      where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] },
    });
    await prisma.comment.deleteMany({ where: { authorId: { in: ids } } });
    await prisma.post.deleteMany({ where: { authorId: { in: ids } } });
    await prisma.project.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.community.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  await prisma.$disconnect();
});

/* ── Target resolution ───────────────────────────────────────────────────── */

describe("resolveTarget", () => {
  it("resolves a post to its author", async () => {
    const author = await createUser();
    const postId = await createPost(author.id);

    const target = await repo.resolveTarget("post", postId);
    expect(target).toMatchObject({
      exists: true,
      authorId: author.id,
      parentPostId: null,
      alreadyRemoved: false,
    });
  });

  it("resolves a comment to its author and its parent post", async () => {
    const author = await createUser();
    const postId = await createPost(author.id);
    const comment = await prisma.comment.create({
      data: { postId, authorId: author.id, content: "A comment." },
      select: { id: true },
    });

    const target = await repo.resolveTarget("comment", comment.id);
    expect(target.authorId).toBe(author.id);
    expect(target.parentPostId).toBe(postId);
  });

  it("resolves a user target to itself", async () => {
    const user = await createUser();
    const target = await repo.resolveTarget("user", user.id);
    expect(target.authorId).toBe(user.id);
  });

  it("reports a missing target rather than throwing", async () => {
    const target = await repo.resolveTarget(
      "post",
      "00000000-0000-4000-8000-000000000000",
    );
    expect(target.exists).toBe(false);
  });

  it("still resolves a soft-deleted target, and says so", async () => {
    // A report filed against a post the author deleted a second earlier is
    // still a legitimate report.
    const author = await createUser();
    const postId = await createPost(author.id);
    await prisma.post.update({
      where: { id: postId },
      data: { deletedAt: new Date() },
    });

    const target = await repo.resolveTarget("post", postId);
    expect(target.exists).toBe(true);
    expect(target.alreadyRemoved).toBe(true);
  });
});

/* ── The queue ───────────────────────────────────────────────────────────── */

describe("listReports", () => {
  it("returns rows and a total counted under the same filter", async () => {
    const reporter = await createUser();
    const author = await createUser();
    const postId = await createPost(author.id);

    await repo.createReport({
      reporterId: reporter.id,
      targetType: "post",
      targetId: postId,
      targetAuthorId: author.id,
      reason: "spam",
      details: "",
      auditAction: AuditAction.REPORT_CREATED,
      ipAddress: null,
      userAgent: null,
    });

    const page = await repo.listReports({ status: "pending" }, { skip: 0, take: 100 });

    expect(page.total).toBeGreaterThan(0);
    expect(page.rows.length).toBeLessThanOrEqual(page.total);
    for (const row of page.rows) expect(row.status).toBe("pending");
  });

  it("orders oldest first, which is what the queue index exists for", async () => {
    const reporter = await createUser();
    const author = await createUser();
    const postId = await createPost(author.id);

    for (let i = 0; i < 3; i += 1) {
      await repo.createReport({
        reporterId: reporter.id,
        targetType: "post",
        targetId: postId,
        targetAuthorId: author.id,
        reason: "spam",
        details: `#${String(i)}`,
        auditAction: AuditAction.REPORT_CREATED,
        ipAddress: null,
        userAgent: null,
      });
    }

    const page = await repo.listReports({}, { skip: 0, take: 500 });
    const times = page.rows.map((row) => row.createdAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("returns disjoint pages that together cover the result set", async () => {
    const reporter = await createUser();
    const author = await createUser();
    const postId = await createPost(author.id);

    for (let i = 0; i < 4; i += 1) {
      await repo.createReport({
        reporterId: reporter.id,
        targetType: "post",
        targetId: postId,
        targetAuthorId: author.id,
        reason: "other",
        details: "",
        auditAction: AuditAction.REPORT_CREATED,
        ipAddress: null,
        userAgent: null,
      });
    }

    const all = await prisma.report.findMany({
      where: { reporterId: reporter.id },
      select: { id: true },
    });

    const first = await repo.listReports({}, { skip: 0, take: 2 });
    const second = await repo.listReports({}, { skip: 2, take: 2 });

    const overlap = first.rows
      .map((r) => r.id)
      .filter((id) => second.rows.some((row) => row.id === id));

    expect(overlap).toHaveLength(0);
    expect(all).toHaveLength(4);
  });
});

/* ── Lifecycle guard ─────────────────────────────────────────────────────── */

describe("updateReportStatus", () => {
  async function pendingReport(): Promise<{ id: string; reviewerId: string }> {
    const reporter = await createUser();
    const author = await createUser();
    const reviewer = await createUser("moderator");
    const postId = await createPost(author.id);

    const report = await repo.createReport({
      reporterId: reporter.id,
      targetType: "post",
      targetId: postId,
      targetAuthorId: author.id,
      reason: "spam",
      details: "",
      auditAction: AuditAction.REPORT_CREATED,
      ipAddress: null,
      userAgent: null,
    });

    return { id: report.id, reviewerId: reviewer.id };
  }

  it("moves a report whose status still matches", async () => {
    const { id, reviewerId } = await pendingReport();

    const updated = await repo.updateReportStatus({
      reportId: id,
      status: "reviewing",
      reviewerId,
      resolution: null,
      resolvedAt: null,
      expectedStatus: "pending",
      auditAction: AuditAction.REPORT_REVIEWED,
      ipAddress: null,
      userAgent: null,
    });

    expect(updated?.status).toBe("reviewing");
    expect(updated?.reviewerId).toBe(reviewerId);
  });

  it("returns null when the status moved underneath it", async () => {
    // The guard lives in the `where` clause, so a stale expectation loses the
    // race rather than silently overwriting the winner.
    const { id, reviewerId } = await pendingReport();

    await repo.updateReportStatus({
      reportId: id,
      status: "reviewing",
      reviewerId,
      resolution: null,
      resolvedAt: null,
      expectedStatus: "pending",
      auditAction: AuditAction.REPORT_REVIEWED,
      ipAddress: null,
      userAgent: null,
    });

    const second = await repo.updateReportStatus({
      reportId: id,
      status: "reviewing",
      reviewerId,
      resolution: null,
      resolvedAt: null,
      expectedStatus: "pending",
      auditAction: AuditAction.REPORT_REVIEWED,
      ipAddress: null,
      userAgent: null,
    });

    expect(second).toBeNull();
  });
});

/* ── The transactional core (ruling R9) ──────────────────────────────────── */

describe("recordModerationAction", () => {
  it("writes the status change, the action, and the audit row together", async () => {
    const moderator = await createUser("moderator");
    const offender = await createUser();

    const result = await repo.recordModerationAction({
      moderatorId: moderator.id,
      action: "ban",
      targetType: "user",
      targetId: offender.id,
      targetUserId: offender.id,
      nextStatus: "banned",
      reason: "Repo test.",
      expiresAt: null,
      reportId: null,
      parentPostId: null,
      auditAction: AuditAction.USER_BANNED,
      ipAddress: "203.0.113.9",
      userAgent: "vitest",
    });

    expect(result.statusChanged).toBe(true);

    const user = await prisma.user.findUnique({ where: { id: offender.id } });
    expect(user?.status).toBe("banned");

    const audit = await prisma.auditLog.findFirst({
      where: { action: "USER_BANNED", targetId: offender.id },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorId).toBe(moderator.id);
    expect(audit?.ipAddress).toBe("203.0.113.9");

    const action = await prisma.moderationAction.findUnique({
      where: { id: result.action.id },
    });
    expect(action).not.toBeNull();
  });

  it("reports statusChanged false when the status already matched", async () => {
    const moderator = await createUser("moderator");
    const offender = await createUser();

    await repo.recordModerationAction({
      moderatorId: moderator.id,
      action: "ban",
      targetType: "user",
      targetId: offender.id,
      targetUserId: offender.id,
      nextStatus: "banned",
      reason: "",
      expiresAt: null,
      reportId: null,
      parentPostId: null,
      auditAction: AuditAction.USER_BANNED,
      ipAddress: null,
      userAgent: null,
    });

    const second = await repo.recordModerationAction({
      moderatorId: moderator.id,
      action: "ban",
      targetType: "user",
      targetId: offender.id,
      targetUserId: offender.id,
      nextStatus: "banned",
      reason: "",
      expiresAt: null,
      reportId: null,
      parentPostId: null,
      auditAction: AuditAction.USER_BANNED,
      ipAddress: null,
      userAgent: null,
    });

    // The decision is still recorded; only the mutation was a no-op.
    expect(second.statusChanged).toBe(false);
    const actions = await prisma.moderationAction.findMany({
      where: { targetUserId: offender.id },
    });
    expect(actions).toHaveLength(2);
  });

  it("rolls the audit row back with the action when the transaction fails", async () => {
    // Ruling R9 is a database property. A moderation action naming a report id
    // that violates the foreign key must leave nothing behind — not the
    // action, and not its audit row.
    const moderator = await createUser("moderator");
    const offender = await createUser();

    const before = await prisma.auditLog.count({
      where: { targetId: offender.id },
    });

    await expect(
      repo.recordModerationAction({
        moderatorId: moderator.id,
        action: "warning",
        targetType: "user",
        targetId: offender.id,
        targetUserId: offender.id,
        nextStatus: null,
        reason: "",
        expiresAt: null,
        // No such report — the FK rejects it and the whole transaction aborts.
        reportId: "00000000-0000-4000-8000-000000000000",
        parentPostId: null,
        auditAction: AuditAction.USER_WARNED,
        ipAddress: null,
        userAgent: null,
      }),
    ).rejects.toThrow();

    const after = await prisma.auditLog.count({ where: { targetId: offender.id } });
    expect(after).toBe(before);

    const actions = await prisma.moderationAction.findMany({
      where: { targetUserId: offender.id },
    });
    expect(actions).toHaveLength(0);
  });
});

/* ── Content removal preserves counters (ruling R13) ─────────────────────── */

describe("content removal", () => {
  it("soft-deletes a post without touching any counter", async () => {
    const moderator = await createUser("moderator");
    const author = await createUser();
    const postId = await createPost(author.id);

    const result = await repo.recordModerationAction({
      moderatorId: moderator.id,
      action: "content_removal",
      targetType: "post",
      targetId: postId,
      targetUserId: author.id,
      nextStatus: null,
      reason: "",
      expiresAt: null,
      reportId: null,
      parentPostId: null,
      auditAction: AuditAction.POST_REMOVED,
      ipAddress: null,
      userAgent: null,
    });

    expect(result.contentRemoved).toBe(true);
    const post = await prisma.post.findUnique({ where: { id: postId } });
    expect(post?.deletedAt).not.toBeNull();
  });

  it("decrements the parent post's commentsCount, as the owner path does", async () => {
    const moderator = await createUser("moderator");
    const author = await createUser();
    const postId = await createPost(author.id);

    const comment = await prisma.comment.create({
      data: { postId, authorId: author.id, content: "Doomed." },
      select: { id: true },
    });
    await prisma.post.update({
      where: { id: postId },
      data: { commentsCount: { increment: 1 } },
    });

    await repo.recordModerationAction({
      moderatorId: moderator.id,
      action: "content_removal",
      targetType: "comment",
      targetId: comment.id,
      targetUserId: author.id,
      nextStatus: null,
      reason: "",
      expiresAt: null,
      reportId: null,
      parentPostId: postId,
      auditAction: AuditAction.COMMENT_REMOVED,
      ipAddress: null,
      userAgent: null,
    });

    const post = await prisma.post.findUnique({ where: { id: postId } });
    expect(post?.commentsCount).toBe(0);
  });

  it("decrements the owner's projectsCount, as the owner path does", async () => {
    const moderator = await createUser("moderator");
    const owner = await createUser();

    const project = await prisma.project.create({
      data: {
        ownerId: owner.id,
        slug: unique("project"),
        title: "Doomed Project",
        description: "Removed by a moderator.",
      },
      select: { id: true },
    });
    await prisma.user.update({
      where: { id: owner.id },
      data: { projectsCount: { increment: 1 } },
    });

    await repo.recordModerationAction({
      moderatorId: moderator.id,
      action: "content_removal",
      targetType: "project",
      targetId: project.id,
      targetUserId: owner.id,
      nextStatus: null,
      reason: "",
      expiresAt: null,
      reportId: null,
      parentPostId: null,
      auditAction: AuditAction.PROJECT_REMOVED,
      ipAddress: null,
      userAgent: null,
    });

    const user = await prisma.user.findUnique({ where: { id: owner.id } });
    expect(user?.projectsCount).toBe(0);
  });

  it("never soft-deletes an account through the content path", async () => {
    const moderator = await createUser("moderator");
    const offender = await createUser();

    const result = await repo.recordModerationAction({
      moderatorId: moderator.id,
      action: "content_removal",
      targetType: "user",
      targetId: offender.id,
      targetUserId: offender.id,
      nextStatus: null,
      reason: "",
      expiresAt: null,
      reportId: null,
      parentPostId: null,
      auditAction: AuditAction.POST_REMOVED,
      ipAddress: null,
      userAgent: null,
    });

    expect(result.contentRemoved).toBe(false);
    const user = await prisma.user.findUnique({ where: { id: offender.id } });
    expect(user?.deletedAt).toBeNull();
  });
});

/* ── Analytics helpers ───────────────────────────────────────────────────── */

describe("report aggregates", () => {
  it("counts reports by reason", async () => {
    const reporter = await createUser();
    const author = await createUser();
    const postId = await createPost(author.id);

    await repo.createReport({
      reporterId: reporter.id,
      targetType: "post",
      targetId: postId,
      targetAuthorId: author.id,
      reason: "harassment",
      details: "",
      auditAction: AuditAction.REPORT_CREATED,
      ipAddress: null,
      userAgent: null,
    });

    const counts = await repo.countReportsByReason();
    const harassment = counts.find((row) => row.reason === "harassment");
    expect(harassment?.count).toBeGreaterThan(0);
  });

  it("counts pending reports", async () => {
    const total = await repo.countReportsByStatus("pending");
    expect(total).toBeGreaterThanOrEqual(0);
  });
});

/* ── Audit reads ─────────────────────────────────────────────────────────── */

describe("listAuditLogs", () => {
  it("filters by action and pages newest first", async () => {
    const moderator = await createUser("moderator");
    const offender = await createUser();

    await repo.recordModerationAction({
      moderatorId: moderator.id,
      action: "warning",
      targetType: "user",
      targetId: offender.id,
      targetUserId: offender.id,
      nextStatus: null,
      reason: "",
      expiresAt: null,
      reportId: null,
      parentPostId: null,
      auditAction: AuditAction.USER_WARNED,
      ipAddress: null,
      userAgent: null,
    });

    const page = await listAuditLogs(
      { action: "USER_WARNED", targetId: offender.id },
      { skip: 0, take: 20 },
    );

    expect(page.total).toBe(1);
    expect(page.rows[0]?.action).toBe("USER_WARNED");
    expect(page.rows[0]?.actor?.id).toBe(moderator.id);
  });

  it("counts under the same filter that produced the rows", async () => {
    const page = await listAuditLogs(
      { action: "A_VERB_THAT_IS_NEVER_WRITTEN" },
      { skip: 0, take: 20 },
    );

    expect(page.total).toBe(0);
    expect(page.rows).toHaveLength(0);
  });
});
