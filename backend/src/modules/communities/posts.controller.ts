import type { RequestHandler } from "express";

import { auditContextFromRequest } from "../../utils/audit.js";
import { successResponse } from "../../utils/response.js";
import { viewerFrom } from "../users/users.controller.js";
import type { CreatePostInput } from "../posts/posts.schema.js";
import { actorFrom, cursorQuery, slugFrom } from "./communities.controller.js";
import * as communityPosts from "./posts.service.js";

/** HTTP adapter for community posts. Thin by design — no business logic. */

export const listCommunityPosts: RequestHandler = async (req, res) => {
  const query = cursorQuery(res);
  const page = await communityPosts.list(
    slugFrom(res),
    viewerFrom(req),
    query.cursor,
    query.limit,
  );

  res.json(successResponse(page, "Posts retrieved"));
};

export const createCommunityPost: RequestHandler = async (req, res) => {
  // A `communityId` in the body is stripped by `createPostSchema` before this
  // handler runs — the Phase 4-6 convention for unknown keys — so it can never
  // reach the repository. The community comes from the route (decision J3).
  const post = await communityPosts.create(
    slugFrom(res),
    actorFrom(req),
    req.body as CreatePostInput,
    auditContextFromRequest(req),
  );

  res.status(201).json(successResponse({ post }, "Post created"));
};
