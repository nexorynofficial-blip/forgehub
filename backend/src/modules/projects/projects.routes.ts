import { Router } from "express";

import { optionalAuth, requireAuth } from "../../middleware/auth.middleware.js";
import { validate } from "../../middleware/validation.middleware.js";
import * as engagementController from "./engagement.controller.js";
import * as membersController from "./members.controller.js";
import * as milestonesController from "./milestones.controller.js";
import * as controller from "./projects.controller.js";
import * as updatesController from "./updates.controller.js";
import {
  addMemberSchema,
  childParamSchema,
  createMilestoneSchema,
  createProjectSchema,
  createUpdateSchema,
  cursorQuerySchema,
  editUpdateSchema,
  memberParamSchema,
  offsetQuerySchema,
  projectListQuerySchema,
  slugParamSchema,
  transferOwnershipSchema,
  trendingQuerySchema,
  updateMemberRoleSchema,
  updateMilestoneSchema,
  updateProjectSchema,
} from "./projects.schema.js";

/**
 * Project endpoints (BACKEND_ARCHITECTURE.md §29).
 *
 * `optionalAuth` on every read, not `requireAuth`: a public project must be
 * readable by anonymous visitors, but a signed-in viewer needs their ownership,
 * membership, and block relationship evaluated to resolve private and unlisted
 * visibility.
 *
 * A factory for consistency with the auth and user routers, so any rate limiter
 * added later is constructed after `connectRedis()`.
 */
export function createProjectRouter(): Router {
  const router = Router();

  /* ── Discovery ────────────────────────────────────────────────────────
     `/trending` is declared before `/:slug` so the literal segment always
     wins. `slugify` also reserves "trending", so this is belt and braces. */

  router.get(
    "/trending",
    optionalAuth,
    validate({ query: trendingQuerySchema }),
    controller.listTrending,
  );

  router.get(
    "/",
    optionalAuth,
    validate({ query: projectListQuerySchema }),
    controller.list,
  );

  router.post(
    "/",
    requireAuth,
    validate({ body: createProjectSchema }),
    controller.create,
  );

  /* ── A single project ─────────────────────────────────────────────────── */

  router.get(
    "/:slug",
    optionalAuth,
    validate({ params: slugParamSchema }),
    controller.getBySlug,
  );

  router.patch(
    "/:slug",
    requireAuth,
    validate({ params: slugParamSchema, body: updateProjectSchema }),
    controller.update,
  );

  router.delete(
    "/:slug",
    requireAuth,
    validate({ params: slugParamSchema }),
    controller.remove,
  );

  /** Owner-only, audited, and transactional across both ownership records. */
  router.post(
    "/:slug/transfer",
    requireAuth,
    validate({ params: slugParamSchema, body: transferOwnershipSchema }),
    controller.transferOwnership,
  );

  /* ── Team ─────────────────────────────────────────────────────────────
     Addressed by handle rather than id, as every Phase 4 user route is. */

  router.get(
    "/:slug/members",
    optionalAuth,
    validate({ params: slugParamSchema, query: offsetQuerySchema }),
    membersController.list,
  );

  router.post(
    "/:slug/members",
    requireAuth,
    validate({ params: slugParamSchema, body: addMemberSchema }),
    membersController.add,
  );

  router.patch(
    "/:slug/members/:username",
    requireAuth,
    validate({ params: memberParamSchema, body: updateMemberRoleSchema }),
    membersController.updateRole,
  );

  /** Also the "leave project" path — a member may always remove themselves. */
  router.delete(
    "/:slug/members/:username",
    requireAuth,
    validate({ params: memberParamSchema }),
    membersController.remove,
  );

  /* ── Roadmap ──────────────────────────────────────────────────────────
     Unpaginated: a roadmap is bounded, and the shipped component renders
     every milestone at once. */

  router.get(
    "/:slug/milestones",
    optionalAuth,
    validate({ params: slugParamSchema }),
    milestonesController.list,
  );

  router.post(
    "/:slug/milestones",
    requireAuth,
    validate({ params: slugParamSchema, body: createMilestoneSchema }),
    milestonesController.create,
  );

  router.patch(
    "/:slug/milestones/:id",
    requireAuth,
    validate({ params: childParamSchema, body: updateMilestoneSchema }),
    milestonesController.update,
  );

  router.delete(
    "/:slug/milestones/:id",
    requireAuth,
    validate({ params: childParamSchema }),
    milestonesController.remove,
  );

  /* ── Changelog ────────────────────────────────────────────────────────
     Cursor-paginated: the one project collection that grows without bound. */

  router.get(
    "/:slug/updates",
    optionalAuth,
    validate({ params: slugParamSchema, query: cursorQuerySchema }),
    updatesController.list,
  );

  router.post(
    "/:slug/updates",
    requireAuth,
    validate({ params: slugParamSchema, body: createUpdateSchema }),
    updatesController.create,
  );

  router.patch(
    "/:slug/updates/:id",
    requireAuth,
    validate({ params: childParamSchema, body: editUpdateSchema }),
    updatesController.edit,
  );

  router.delete(
    "/:slug/updates/:id",
    requireAuth,
    validate({ params: childParamSchema }),
    updatesController.remove,
  );

  /* ── Engagement ───────────────────────────────────────────────────────── */

  router.post(
    "/:slug/like",
    requireAuth,
    validate({ params: slugParamSchema }),
    engagementController.like,
  );

  router.delete(
    "/:slug/like",
    requireAuth,
    validate({ params: slugParamSchema }),
    engagementController.unlike,
  );

  router.post(
    "/:slug/follow",
    requireAuth,
    validate({ params: slugParamSchema }),
    engagementController.follow,
  );

  router.delete(
    "/:slug/follow",
    requireAuth,
    validate({ params: slugParamSchema }),
    engagementController.unfollow,
  );

  /** `optionalAuth`: anonymous visitors are most of a public project's audience. */
  router.post(
    "/:slug/view",
    optionalAuth,
    validate({ params: slugParamSchema }),
    engagementController.recordView,
  );

  return router;
}
