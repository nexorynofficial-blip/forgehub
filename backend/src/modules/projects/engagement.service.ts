import { createHash } from "node:crypto";

import { redis } from "../../config/redis.js";
import { notificationPort } from "../../ports/notification.port.js";
import { AppError } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import * as repo from "./projects.repository.js";
import {
  isUniqueViolation,
  loadVisibleProject,
  type Actor,
  type Viewer,
} from "./projects.service.js";
import type { ProjectMetricsView } from "./projects.types.js";

/**
 * Likes, followers, and views.
 *
 * All three enter through `loadVisibleProject`, so a project a viewer cannot
 * see is also a project they cannot like, follow, or inflate the view count
 * of — the gate is not just a read concern.
 *
 * Note one deliberate difference from the Phase 4 social graph: **liking your
 * own project is allowed.** Self-following a *user* is forbidden because it
 * would be a meaningless self-referential edge in the graph, but an owner
 * liking their own project is ordinary behaviour on every platform that has
 * the button, and nothing downstream divides by it.
 */

/** One counted view per viewer-or-IP per project per 24 hours (decision J6). */
const VIEW_DEDUPE_TTL_SECONDS = 86_400;

async function metricsFor(projectId: string): Promise<ProjectMetricsView> {
  const counters = await repo.readCounters(projectId);

  return {
    views: counters?.viewsCount ?? 0,
    likes: counters?.likesCount ?? 0,
    followers: counters?.followersCount ?? 0,
  };
}

/* ── Likes ──────────────────────────────────────────────────────────────── */

export async function like(
  slug: string,
  actor: Actor,
): Promise<{ liked: boolean; metrics: ProjectMetricsView }> {
  const context = await loadVisibleProject(slug, actor);

  try {
    await repo.likeProject(context.row.id, actor.id);
  } catch (error) {
    // The composite primary key is the arbiter under concurrency; this turns
    // the loser of that race into a clean 409 rather than a 500.
    if (isUniqueViolation(error)) {
      throw AppError.conflict("You have already liked this project");
    }
    throw error;
  }

  // Don't notify someone about their own action.
  if (context.row.ownerId !== actor.id) {
    await notificationPort.emit({
      recipientId: context.row.ownerId,
      actorId: actor.id,
      type: "like",
      entityType: "project",
      entityId: context.row.id,
    });
  }

  return { liked: true, metrics: await metricsFor(context.row.id) };
}

/** Idempotent: unliking something you never liked is a success, not a 404. */
export async function unlike(
  slug: string,
  actor: Actor,
): Promise<{ liked: boolean; metrics: ProjectMetricsView }> {
  const context = await loadVisibleProject(slug, actor);
  await repo.unlikeProject(context.row.id, actor.id);

  return { liked: false, metrics: await metricsFor(context.row.id) };
}

/* ── Followers ──────────────────────────────────────────────────────────── */

export async function follow(
  slug: string,
  actor: Actor,
): Promise<{ following: boolean; metrics: ProjectMetricsView }> {
  const context = await loadVisibleProject(slug, actor);

  try {
    await repo.followProject(context.row.id, actor.id);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw AppError.conflict("You are already following this project");
    }
    throw error;
  }

  return { following: true, metrics: await metricsFor(context.row.id) };
}

export async function unfollow(
  slug: string,
  actor: Actor,
): Promise<{ following: boolean; metrics: ProjectMetricsView }> {
  const context = await loadVisibleProject(slug, actor);
  await repo.unfollowProject(context.row.id, actor.id);

  return { following: false, metrics: await metricsFor(context.row.id) };
}

/* ── Views (decision J6) ────────────────────────────────────────────────── */

/**
 * Identity for deduplication: the signed-in user when there is one, otherwise
 * the source address.
 *
 * Hashed before it becomes a Redis key, so a cache dump does not reveal which
 * addresses have been reading which projects — the same treatment
 * `brute-force.ts` gives an email.
 */
function viewerKey(
  projectId: string,
  viewerId: string | null,
  ip: string | null,
): string {
  const identity = viewerId ?? `ip:${ip ?? "unknown"}`;
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 32);

  return `pv:${projectId}:${digest}`;
}

/**
 * Records a view, at most once per identity per project per 24 hours.
 *
 * `SET key 1 EX ttl NX` is the whole mechanism: the write succeeds only if the
 * key is absent, which makes "is this a new view?" a single atomic round trip
 * rather than a read-then-write race between concurrent requests.
 *
 * Fails **closed** if Redis is unavailable — the opposite of the brute-force
 * limiter, and deliberately so. There, failing open costs a degraded defence
 * but keeps people able to sign in; here, failing open would let an outage turn
 * into unbounded view inflation, while failing closed costs nothing but a
 * temporarily flat counter.
 */
export async function recordView(
  slug: string,
  viewer: Viewer,
  ipAddress: string | null,
): Promise<{ counted: boolean; metrics: ProjectMetricsView }> {
  const context = await loadVisibleProject(slug, viewer);

  // An owner refreshing their own project page is not an audience.
  if (viewer.id !== null && viewer.id === context.row.ownerId) {
    return { counted: false, metrics: await metricsFor(context.row.id) };
  }

  let isNew = false;
  try {
    const result = await redis.set(
      viewerKey(context.row.id, viewer.id, ipAddress),
      "1",
      "EX",
      VIEW_DEDUPE_TTL_SECONDS,
      "NX",
    );
    isNew = result === "OK";
  } catch (error) {
    logger.warn({ err: error }, "View not counted — Redis unavailable");
    return { counted: false, metrics: await metricsFor(context.row.id) };
  }

  if (!isNew) {
    return { counted: false, metrics: await metricsFor(context.row.id) };
  }

  await repo.incrementViews(context.row.id);
  return { counted: true, metrics: await metricsFor(context.row.id) };
}
