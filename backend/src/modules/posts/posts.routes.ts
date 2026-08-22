import { Router } from "express";

import { optionalAuth, requireAuth } from "../../middleware/auth.middleware.js";
import { validate } from "../../middleware/validation.middleware.js";
import * as controller from "./posts.controller.js";
import {
  commentIdParamSchema,
  createCommentSchema,
  createPostSchema,
  cursorQuerySchema,
  feedQuerySchema,
  newCountQuerySchema,
  postIdParamSchema,
  updateCommentSchema,
  updatePostSchema,
  voteSchema,
} from "./posts.schema.js";

/**
 * Post, comment, and feed endpoints (BACKEND_ARCHITECTURE.md §29).
 *
 * Three routers rather than one, matching decision J3's hybrid: comments are
 * *listed and created* under their post, but *mutated* by their own globally
 * unique id — which is both what ARCHITECTURE §29's `/api/v1/comments` prefix
 * asks for and what a client editing a comment actually has in hand.
 *
 * `optionalAuth` on every read: a public post must be readable by anonymous
 * visitors, but a signed-in viewer needs their authorship and block
 * relationship evaluated to resolve private and unlisted visibility.
 */

export function createPostRouter(): Router {
  const router = Router();

  router.post("/", requireAuth, validate({ body: createPostSchema }), controller.create);

  router.get(
    "/:id",
    optionalAuth,
    validate({ params: postIdParamSchema }),
    controller.getById,
  );

  router.patch(
    "/:id",
    requireAuth,
    validate({ params: postIdParamSchema, body: updatePostSchema }),
    controller.update,
  );

  router.delete(
    "/:id",
    requireAuth,
    validate({ params: postIdParamSchema }),
    controller.remove,
  );

  /* ── Comments under their post (decision J3) ──────────────────────────── */

  router.get(
    "/:id/comments",
    optionalAuth,
    validate({ params: postIdParamSchema, query: cursorQuerySchema }),
    controller.listComments,
  );

  router.post(
    "/:id/comments",
    requireAuth,
    validate({ params: postIdParamSchema, body: createCommentSchema }),
    controller.createComment,
  );

  /* ── Engagement ───────────────────────────────────────────────────────── */

  router.post(
    "/:id/like",
    requireAuth,
    validate({ params: postIdParamSchema }),
    controller.likePost,
  );

  router.delete(
    "/:id/like",
    requireAuth,
    validate({ params: postIdParamSchema }),
    controller.unlikePost,
  );

  router.post(
    "/:id/bookmark",
    requireAuth,
    validate({ params: postIdParamSchema }),
    controller.addBookmark,
  );

  router.delete(
    "/:id/bookmark",
    requireAuth,
    validate({ params: postIdParamSchema }),
    controller.removeBookmark,
  );

  /** Votes name an option, not a poll — see `posts.schema.voteSchema`. */
  router.post(
    "/:id/poll/vote",
    requireAuth,
    validate({ params: postIdParamSchema, body: voteSchema }),
    controller.vote,
  );

  return router;
}

/**
 * `/comments` — mutation by globally unique id, plus reply listing.
 *
 * There is deliberately no `POST /comments`: creating one requires a post, and
 * an endpoint that took `postId` in the body would be a second write path to
 * the same thing.
 */
export function createCommentRouter(): Router {
  const router = Router();

  router.get(
    "/:id/replies",
    optionalAuth,
    validate({ params: commentIdParamSchema, query: cursorQuerySchema }),
    controller.listReplies,
  );

  router.patch(
    "/:id",
    requireAuth,
    validate({ params: commentIdParamSchema, body: updateCommentSchema }),
    controller.updateComment,
  );

  router.delete(
    "/:id",
    requireAuth,
    validate({ params: commentIdParamSchema }),
    controller.removeComment,
  );

  router.post(
    "/:id/like",
    requireAuth,
    validate({ params: commentIdParamSchema }),
    controller.likeComment,
  );

  router.delete(
    "/:id/like",
    requireAuth,
    validate({ params: commentIdParamSchema }),
    controller.unlikeComment,
  );

  return router;
}

/**
 * `/feed` — TRD §5 names this endpoint explicitly, separate from `/posts`.
 *
 * `/new-count` is declared before any parameterised route so the literal
 * segment always wins.
 */
export function createFeedRouter(): Router {
  const router = Router();

  router.get(
    "/new-count",
    optionalAuth,
    validate({ query: newCountQuerySchema }),
    controller.getNewCount,
  );

  router.get("/", optionalAuth, validate({ query: feedQuerySchema }), controller.getFeed);

  return router;
}
