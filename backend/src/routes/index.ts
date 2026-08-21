import { Router } from "express";

import { createAuthRouter } from "../modules/auth/auth.routes.js";
import { createProjectRouter } from "../modules/projects/projects.routes.js";
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

  return router;
}
