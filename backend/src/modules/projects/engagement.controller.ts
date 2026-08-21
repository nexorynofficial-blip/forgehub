import type { RequestHandler } from "express";

import { successResponse } from "../../utils/response.js";
import { viewerFrom } from "../users/users.controller.js";
import { actorFrom, slugFrom } from "./projects.controller.js";
import * as engagementService from "./engagement.service.js";

/** HTTP adapter for likes, followers, and views. */

export const like: RequestHandler = async (req, res) => {
  const result = await engagementService.like(slugFrom(res), actorFrom(req));
  res.status(201).json(successResponse(result, "Project liked"));
};

export const unlike: RequestHandler = async (req, res) => {
  const result = await engagementService.unlike(slugFrom(res), actorFrom(req));
  res.json(successResponse(result, "Project unliked"));
};

export const follow: RequestHandler = async (req, res) => {
  const result = await engagementService.follow(slugFrom(res), actorFrom(req));
  res.status(201).json(successResponse(result, "Project followed"));
};

export const unfollow: RequestHandler = async (req, res) => {
  const result = await engagementService.unfollow(slugFrom(res), actorFrom(req));
  res.json(successResponse(result, "Project unfollowed"));
};

/**
 * `optionalAuth`, not `requireAuth`: anonymous visitors are most of a public
 * project's audience, and a view counter that only counted signed-in readers
 * would understate it badly. Deduplication falls back to the source address
 * for them (decision J6).
 */
export const recordView: RequestHandler = async (req, res) => {
  const result = await engagementService.recordView(
    slugFrom(res),
    viewerFrom(req),
    req.ip ?? null,
  );

  res.json(successResponse(result, "View recorded"));
};
