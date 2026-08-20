import type { RequestHandler } from "express";

import { validated } from "../../middleware/validation.middleware.js";
import { auditContextFromRequest } from "../../utils/audit.js";
import { successResponse } from "../../utils/response.js";
import { requireUser, viewerFrom } from "../users/users.controller.js";
import type { UsernameParam } from "../users/users.schema.js";
import * as followsService from "./follows.service.js";
import type { FollowListQuery } from "./follows.schema.js";

/**
 * HTTP adapter for the social graph.
 *
 * The actor is always `requireUser(req).id`. The path parameter names the
 * *target*, never the actor — so there is no request shape in which a client
 * can make someone else follow, unfollow, or block on their behalf.
 */

function targetUsername(res: Parameters<RequestHandler>[1]): string {
  return validated<UsernameParam>(res, "Params").username;
}

function pageQuery(res: Parameters<RequestHandler>[1]): {
  cursor?: string | undefined;
  limit: number;
} {
  const query = validated<FollowListQuery>(res, "Query");
  return { cursor: query.cursor, limit: query.limit };
}

export const follow: RequestHandler = async (req, res) => {
  const result = await followsService.follow(requireUser(req).id, targetUsername(res));

  res.status(201).json(successResponse(result, "Followed"));
};

export const unfollow: RequestHandler = async (req, res) => {
  const result = await followsService.unfollow(requireUser(req).id, targetUsername(res));

  res.json(successResponse(result, "Unfollowed"));
};

export const listFollowers: RequestHandler = async (req, res) => {
  const page = await followsService.listFollowers(
    targetUsername(res),
    viewerFrom(req),
    pageQuery(res),
  );

  res.json(successResponse(page, "Followers retrieved"));
};

export const listFollowing: RequestHandler = async (req, res) => {
  const page = await followsService.listFollowing(
    targetUsername(res),
    viewerFrom(req),
    pageQuery(res),
  );

  res.json(successResponse(page, "Following retrieved"));
};

export const getRelationship: RequestHandler = async (req, res) => {
  const relationship = await followsService.getRelationship(
    requireUser(req).id,
    targetUsername(res),
  );

  res.json(successResponse({ relationship }, "Relationship retrieved"));
};

export const block: RequestHandler = async (req, res) => {
  const result = await followsService.block(
    requireUser(req).id,
    targetUsername(res),
    auditContextFromRequest(req),
  );

  res.status(201).json(successResponse(result, "User blocked"));
};

export const unblock: RequestHandler = async (req, res) => {
  const result = await followsService.unblock(
    requireUser(req).id,
    targetUsername(res),
    auditContextFromRequest(req),
  );

  res.json(successResponse(result, "User unblocked"));
};

export const listBlocked: RequestHandler = async (req, res) => {
  const page = await followsService.listBlocked(requireUser(req).id, pageQuery(res));
  res.json(successResponse(page, "Blocked users retrieved"));
};
