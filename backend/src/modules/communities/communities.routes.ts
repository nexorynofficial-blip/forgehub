import { Router } from "express";

import { optionalAuth, requireAuth } from "../../middleware/auth.middleware.js";
import { validate } from "../../middleware/validation.middleware.js";
import { createPostSchema } from "../posts/posts.schema.js";
import * as controller from "./communities.controller.js";
import * as membersController from "./members.controller.js";
import * as postsController from "./posts.controller.js";
import * as resourcesController from "./resources.controller.js";
import {
  addMemberSchema,
  communityChildParamSchema,
  communityCursorQuerySchema,
  communityListQuerySchema,
  communityMemberParamSchema,
  communitySlugParamSchema,
  createCommunitySchema,
  createEventSchema,
  eventListQuerySchema,
  memberRoleSchema,
  pinPostSchema,
  replaceRulesSchema,
  replaceTagsSchema,
  transferOwnershipSchema,
  updateCommunitySchema,
  updateEventSchema,
} from "./communities.schema.js";

/**
 * Community endpoints (BACKEND_ARCHITECTURE.md §29, TRD §5).
 *
 * `optionalAuth` on every read, not `requireAuth`: a public community must be
 * readable by anonymous visitors, but a signed-in viewer needs their ownership,
 * membership, and block relationship evaluated to resolve private and unlisted
 * visibility.
 *
 * A factory for consistency with the auth, user, project, and post routers, so
 * any rate limiter added later is constructed after `connectRedis()`.
 *
 * This router covers discovery, the community itself, and membership. Rules,
 * events, pins, and community posts are mounted in a later chunk.
 */
export function createCommunityRouter(): Router {
  const router = Router();

  /* ── Discovery ────────────────────────────────────────────────────────── */

  router.get(
    "/",
    optionalAuth,
    validate({ query: communityListQuerySchema }),
    controller.list,
  );

  router.post(
    "/",
    requireAuth,
    validate({ body: createCommunitySchema }),
    controller.create,
  );

  /* ── A single community ───────────────────────────────────────────────── */

  router.get(
    "/:slug",
    optionalAuth,
    validate({ params: communitySlugParamSchema }),
    controller.getBySlug,
  );

  router.patch(
    "/:slug",
    requireAuth,
    validate({ params: communitySlugParamSchema, body: updateCommunitySchema }),
    controller.update,
  );

  router.delete(
    "/:slug",
    requireAuth,
    validate({ params: communitySlugParamSchema }),
    controller.remove,
  );

  /* ── Membership ───────────────────────────────────────────────────────────
     `/members` and `/moderators` are declared before the `/:username` member
     routes so the literal segments always win, the same ordering discipline
     `/projects/trending` needs. */

  router.get(
    "/:slug/members",
    optionalAuth,
    validate({ params: communitySlugParamSchema, query: communityCursorQuerySchema }),
    membersController.list,
  );

  router.get(
    "/:slug/moderators",
    optionalAuth,
    validate({ params: communitySlugParamSchema }),
    membersController.listModerators,
  );

  router.post(
    "/:slug/members",
    requireAuth,
    validate({ params: communitySlugParamSchema, body: addMemberSchema }),
    membersController.add,
  );

  /* Self-service. Separate verbs from the managed routes above, because the
     authorization question is different: joining needs no permission, only a
     community that permits it (decision J5). */

  router.post(
    "/:slug/join",
    requireAuth,
    validate({ params: communitySlugParamSchema }),
    membersController.join,
  );

  router.delete(
    "/:slug/leave",
    requireAuth,
    validate({ params: communitySlugParamSchema }),
    membersController.leave,
  );

  router.patch(
    "/:slug/members/:username",
    requireAuth,
    validate({ params: communityMemberParamSchema, body: memberRoleSchema }),
    membersController.updateRole,
  );

  router.delete(
    "/:slug/members/:username",
    requireAuth,
    validate({ params: communityMemberParamSchema }),
    membersController.remove,
  );

  /* ── Ownership (decision J7) ──────────────────────────────────────────── */

  router.post(
    "/:slug/transfer",
    requireAuth,
    validate({ params: communitySlugParamSchema, body: transferOwnershipSchema }),
    membersController.transfer,
  );

  /* ── Rules and tags (decisions J8, J11) ───────────────────────────────────
     `PUT`, not `PATCH`: both are replace-set semantics, and the whole list is
     the resource. A `PATCH` would imply a merge nobody implements. */

  router.put(
    "/:slug/rules",
    requireAuth,
    validate({ params: communitySlugParamSchema, body: replaceRulesSchema }),
    resourcesController.replaceRules,
  );

  router.put(
    "/:slug/tags",
    requireAuth,
    validate({ params: communitySlugParamSchema, body: replaceTagsSchema }),
    resourcesController.replaceTags,
  );

  /* ── Events (decision J10) ────────────────────────────────────────────── */

  router.get(
    "/:slug/events",
    optionalAuth,
    validate({ params: communitySlugParamSchema, query: eventListQuerySchema }),
    resourcesController.listEvents,
  );

  router.post(
    "/:slug/events",
    requireAuth,
    validate({ params: communitySlugParamSchema, body: createEventSchema }),
    resourcesController.createEvent,
  );

  router.patch(
    "/:slug/events/:id",
    requireAuth,
    validate({ params: communityChildParamSchema, body: updateEventSchema }),
    resourcesController.updateEvent,
  );

  router.delete(
    "/:slug/events/:id",
    requireAuth,
    validate({ params: communityChildParamSchema }),
    resourcesController.deleteEvent,
  );

  /* ── Pinned posts (decision J14) ──────────────────────────────────────── */

  router.get(
    "/:slug/pins",
    optionalAuth,
    validate({ params: communitySlugParamSchema }),
    resourcesController.listPins,
  );

  router.post(
    "/:slug/pins",
    requireAuth,
    validate({ params: communitySlugParamSchema, body: pinPostSchema }),
    resourcesController.pinPost,
  );

  router.delete(
    "/:slug/pins/:id",
    requireAuth,
    validate({ params: communityChildParamSchema }),
    resourcesController.unpinPost,
  );

  /* ── Community posts (decision J3) ────────────────────────────────────────
     Creation is addressed here and nowhere else: `communityId` comes from the
     resolved community, never from a request body, so a client cannot publish
     into a community it has no standing in. */

  router.get(
    "/:slug/posts",
    optionalAuth,
    validate({ params: communitySlugParamSchema, query: communityCursorQuerySchema }),
    postsController.listCommunityPosts,
  );

  router.post(
    "/:slug/posts",
    requireAuth,
    validate({ params: communitySlugParamSchema, body: createPostSchema }),
    postsController.createCommunityPost,
  );

  return router;
}
