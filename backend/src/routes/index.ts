import { Router } from "express";

import { createAuthRouter } from "../modules/auth/auth.routes.js";
import { createCommunityRouter } from "../modules/communities/communities.routes.js";
import { createMessageRouter } from "../modules/messages/messages.routes.js";
import { createNotificationRouter } from "../modules/notifications/notifications.routes.js";
import {
  createCommentRouter,
  createFeedRouter,
  createPostRouter,
} from "../modules/posts/posts.routes.js";
import { createProjectRouter } from "../modules/projects/projects.routes.js";
import { createSearchRouter } from "../modules/search/search.routes.js";
import { createUserRouter } from "../modules/users/users.routes.js";
import { successResponse } from "../utils/response.js";

/**
 * API v1 root router (BACKEND_TRD.md §36, BACKEND_ARCHITECTURE.md §29).
 *
 * A factory rather than a module-level singleton: feature routers build
 * Redis-backed rate limiters at construction time, which must happen after
 * `connectRedis()` — the same reason `createGlobalRateLimiter()` is called
 * from inside `createApp()`.
 *
 * Later phases mount here, keeping the version prefix in exactly one place:
 *
 *   router.use("/users", createUserRouter());
 *   ...
 */
export function createV1Router(): Router {
  const router = Router();

  /** Discovery endpoint — confirms the version is mounted and reachable. */
  router.get("/", (_req, res) => {
    res.json(
      successResponse(
        { version: "v1", status: "operational" },
        "ForgeHub API v1 is operational",
      ),
    );
  });

  router.use("/auth", createAuthRouter());
  // Users and the social graph share this prefix — the follow/block routes are
  // all addressed as actions on a user (see `users.routes.ts`). The users
  // router also mounts `/users/:username/projects`, which belongs to the
  // projects module but is addressed as a property of a profile.
  router.use("/users", createUserRouter());
  router.use("/projects", createProjectRouter());
  // Posts, comments, and the feed (Phase 6). Comments are listed and created
  // under their post but mutated by their own id — ARCHITECTURE §29 asks for
  // the `/comments` prefix, and TRD §5 names `/feed` separately from `/posts`.
  router.use("/posts", createPostRouter());
  router.use("/comments", createCommentRouter());
  router.use("/feed", createFeedRouter());
  // Communities (Phase 7). TRD §5 names `/communities`; membership lives under
  // it because a membership is only ever addressed through its community.
  router.use("/communities", createCommunityRouter());
  // Messaging (Phase 8). ARCHITECTURE §11 names `/messages`; conversations live
  // under it because a conversation is only ever addressed through this domain,
  // and every route requires authentication — there is no public correspondence.
  router.use("/messages", createMessageRouter());
  // Notifications (Phase 9). TRD §5 names `GET /notifications`; every route
  // requires authentication because a notification list is a digest of one
  // person's received activity and has no public face.
  router.use("/notifications", createNotificationRouter());
  // Search (Phase 10). ARCHITECTURE §29 names `/search`; it is a single route
  // with an entity filter rather than one route per entity, and `optionalAuth`
  // rather than `requireAuth` — public content must be findable by anonymous
  // visitors, and a signed-in viewer only widens what *they* may discover.
  router.use("/search", createSearchRouter());

  return router;
}
