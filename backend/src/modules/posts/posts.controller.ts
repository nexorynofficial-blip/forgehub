import type { Request, RequestHandler } from "express";

import { validated } from "../../middleware/validation.middleware.js";
import { auditContextFromRequest } from "../../utils/audit.js";
import { successResponse } from "../../utils/response.js";
import { requireUser, viewerFrom } from "../users/users.controller.js";
import type { UsernameParam } from "../users/users.schema.js";
import * as commentsService from "./comments.service.js";
import * as engagementService from "./engagement.service.js";
import * as feedService from "./feed.service.js";
import * as postsService from "./posts.service.js";
import type {
  CommentIdParam,
  CreateCommentInput,
  CreatePostInput,
  CursorQuery,
  FeedQuery,
  NewCountQuery,
  PostIdParam,
  UpdateCommentInput,
  UpdatePostInput,
  VoteInput,
} from "./posts.schema.js";

/**
 * HTTP adapter for the posts module (BACKEND_ARCHITECTURE.md §4–5).
 *
 * Translates between HTTP and the services and nothing else. Every mutating
 * handler passes `actorFrom(req)` — identity from the verified access token —
 * so no body or path value can select whose post is written.
 */

export function actorFrom(req: Request): postsService.Actor {
  const user = requireUser(req);
  return { id: user.id, role: user.role };
}

function postId(res: Parameters<RequestHandler>[1]): string {
  return validated<PostIdParam>(res, "Params").id;
}

function commentId(res: Parameters<RequestHandler>[1]): string {
  return validated<CommentIdParam>(res, "Params").id;
}

function cursorQuery(res: Parameters<RequestHandler>[1]): CursorQuery {
  return validated<CursorQuery>(res, "Query");
}

/* ── Posts ──────────────────────────────────────────────────────────────── */

export const getById: RequestHandler = async (req, res) => {
  const result = await postsService.getById(postId(res), viewerFrom(req));

  res.json(
    successResponse({ post: result.post, viewer: result.viewer }, "Post retrieved"),
  );
};

export const create: RequestHandler = async (req, res) => {
  const post = await postsService.create(
    actorFrom(req),
    req.body as CreatePostInput,
    auditContextFromRequest(req),
  );

  res.status(201).json(successResponse({ post }, "Post created"));
};

export const update: RequestHandler = async (req, res) => {
  const post = await postsService.update(
    postId(res),
    actorFrom(req),
    req.body as UpdatePostInput,
  );

  res.json(successResponse({ post }, "Post updated"));
};

export const remove: RequestHandler = async (req, res) => {
  const result = await postsService.remove(
    postId(res),
    actorFrom(req),
    auditContextFromRequest(req),
  );

  res.json(successResponse(result, "Post deleted"));
};

/* ── Feed ───────────────────────────────────────────────────────────────── */

export const getFeed: RequestHandler = async (req, res) => {
  const page = await feedService.getFeed(
    viewerFrom(req),
    validated<FeedQuery>(res, "Query"),
  );
  res.json(successResponse(page, "Feed retrieved"));
};

export const getNewCount: RequestHandler = async (req, res) => {
  const result = await feedService.getNewCount(
    viewerFrom(req),
    validated<NewCountQuery>(res, "Query"),
  );

  res.json(successResponse(result, "New post count retrieved"));
};

export const listByAuthor: RequestHandler = async (req, res) => {
  const { username } = validated<UsernameParam>(res, "Params");
  const page = await feedService.getByAuthor(username, viewerFrom(req), cursorQuery(res));

  res.json(successResponse(page, "Posts retrieved"));
};

export const listBookmarks: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const page = await feedService.getBookmarks(user.id, viewerFrom(req), cursorQuery(res));

  res.json(successResponse(page, "Bookmarks retrieved"));
};

/* ── Comments ───────────────────────────────────────────────────────────── */

export const listComments: RequestHandler = async (req, res) => {
  const page = await commentsService.list(postId(res), viewerFrom(req), cursorQuery(res));
  res.json(successResponse(page, "Comments retrieved"));
};

export const createComment: RequestHandler = async (req, res) => {
  const comment = await commentsService.create(
    postId(res),
    actorFrom(req),
    req.body as CreateCommentInput,
  );

  res.status(201).json(successResponse({ comment }, "Comment posted"));
};

export const listReplies: RequestHandler = async (req, res) => {
  const page = await commentsService.listReplies(
    commentId(res),
    viewerFrom(req),
    cursorQuery(res),
  );

  res.json(successResponse(page, "Replies retrieved"));
};

export const updateComment: RequestHandler = async (req, res) => {
  const comment = await commentsService.update(
    commentId(res),
    actorFrom(req),
    req.body as UpdateCommentInput,
  );

  res.json(successResponse({ comment }, "Comment updated"));
};

export const removeComment: RequestHandler = async (req, res) => {
  const result = await commentsService.remove(
    commentId(res),
    actorFrom(req),
    auditContextFromRequest(req),
  );

  res.json(successResponse(result, "Comment deleted"));
};

/* ── Engagement ─────────────────────────────────────────────────────────── */

export const likePost: RequestHandler = async (req, res) => {
  const result = await engagementService.likePost(postId(res), actorFrom(req));
  res.status(201).json(successResponse(result, "Post liked"));
};

export const unlikePost: RequestHandler = async (req, res) => {
  const result = await engagementService.unlikePost(postId(res), actorFrom(req));
  res.json(successResponse(result, "Post unliked"));
};

export const likeComment: RequestHandler = async (req, res) => {
  const result = await engagementService.likeComment(commentId(res), actorFrom(req));
  res.status(201).json(successResponse(result, "Comment liked"));
};

export const unlikeComment: RequestHandler = async (req, res) => {
  const result = await engagementService.unlikeComment(commentId(res), actorFrom(req));
  res.json(successResponse(result, "Comment unliked"));
};

export const addBookmark: RequestHandler = async (req, res) => {
  const result = await engagementService.addBookmark(postId(res), actorFrom(req));
  res.status(201).json(successResponse(result, "Post bookmarked"));
};

export const removeBookmark: RequestHandler = async (req, res) => {
  const result = await engagementService.removeBookmark(postId(res), actorFrom(req));
  res.json(successResponse(result, "Bookmark removed"));
};

export const vote: RequestHandler = async (req, res) => {
  const { optionId } = req.body as VoteInput;
  const result = await engagementService.vote(postId(res), optionId, actorFrom(req));

  res.status(201).json(successResponse(result, "Vote recorded"));
};
