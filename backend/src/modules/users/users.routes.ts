import { Router } from "express";

import { optionalAuth, requireAuth } from "../../middleware/auth.middleware.js";
import { validate } from "../../middleware/validation.middleware.js";
import * as followsController from "../follows/follows.controller.js";
import { followListQuerySchema } from "../follows/follows.schema.js";
import * as controller from "./users.controller.js";
import {
  updateNotificationPreferenceSchema,
  updateProfileSchema,
  updateSettingsSchema,
  updateUsernameSchema,
  usernameParamSchema,
} from "./users.schema.js";

/**
 * User and social-graph endpoints (BACKEND_ARCHITECTURE.md §29).
 *
 * The social graph mounts here rather than under its own prefix because its
 * routes are all *about a user*: `/users/:username/follow` reads better than
 * `/follows/:username`, and it keeps the frontend's mental model (a profile
 * page acts on a profile) intact.
 *
 * A factory for consistency with the auth router, so any rate limiter added
 * later is constructed after `connectRedis()`.
 */
export function createUserRouter(): Router {
  const router = Router();

  /* ── Own account ──────────────────────────────────────────────────────
     Declared before `/:username` so the literal segment always wins. The
     schema also reserves "me" as a handle, so this is belt and braces. */

  router.get("/me", requireAuth, controller.getCurrentUser);

  router.patch(
    "/me",
    requireAuth,
    validate({ body: updateProfileSchema }),
    controller.updateProfile,
  );

  router.patch(
    "/me/username",
    requireAuth,
    validate({ body: updateUsernameSchema }),
    controller.updateUsername,
  );

  router.get("/me/settings", requireAuth, controller.getSettings);

  router.patch(
    "/me/settings",
    requireAuth,
    validate({ body: updateSettingsSchema }),
    controller.updateSettings,
  );

  router.get(
    "/me/notification-preferences",
    requireAuth,
    controller.getNotificationPreferences,
  );

  router.patch(
    "/me/notification-preferences",
    requireAuth,
    validate({ body: updateNotificationPreferenceSchema }),
    controller.updateNotificationPreference,
  );

  /** The caller's own block list. Never exposed for another user. */
  router.get(
    "/me/blocks",
    requireAuth,
    validate({ query: followListQuerySchema }),
    followsController.listBlocked,
  );

  /* ── Public profiles ──────────────────────────────────────────────────
     `optionalAuth`, not `requireAuth`: a public profile must be readable by
     anonymous visitors, but a signed-in viewer needs their relationship
     evaluated to resolve followers-only visibility and blocks. */

  router.get(
    "/:username",
    optionalAuth,
    validate({ params: usernameParamSchema }),
    controller.getByUsername,
  );

  router.get(
    "/:username/achievements",
    optionalAuth,
    validate({ params: usernameParamSchema }),
    controller.getAchievements,
  );

  router.get(
    "/:username/followers",
    optionalAuth,
    validate({ params: usernameParamSchema, query: followListQuerySchema }),
    followsController.listFollowers,
  );

  router.get(
    "/:username/following",
    optionalAuth,
    validate({ params: usernameParamSchema, query: followListQuerySchema }),
    followsController.listFollowing,
  );

  /* ── Social graph mutations ───────────────────────────────────────────
     All require authentication; the actor is the token holder. */

  router.get(
    "/:username/relationship",
    requireAuth,
    validate({ params: usernameParamSchema }),
    followsController.getRelationship,
  );

  router.post(
    "/:username/follow",
    requireAuth,
    validate({ params: usernameParamSchema }),
    followsController.follow,
  );

  router.delete(
    "/:username/follow",
    requireAuth,
    validate({ params: usernameParamSchema }),
    followsController.unfollow,
  );

  router.post(
    "/:username/block",
    requireAuth,
    validate({ params: usernameParamSchema }),
    followsController.block,
  );

  router.delete(
    "/:username/block",
    requireAuth,
    validate({ params: usernameParamSchema }),
    followsController.unblock,
  );

  return router;
}
