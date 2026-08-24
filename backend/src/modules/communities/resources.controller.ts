import type { RequestHandler } from "express";

import { validated } from "../../middleware/validation.middleware.js";
import { successResponse } from "../../utils/response.js";
import { viewerFrom } from "../users/users.controller.js";
import { actorFrom, slugFrom } from "./communities.controller.js";
import * as resources from "./resources.service.js";
import type {
  CommunityChildParam,
  CreateEventInput,
  EventListQuery,
  PinPostInput,
  ReplaceRulesInput,
  ReplaceTagsInput,
  UpdateEventInput,
} from "./communities.schema.js";

/**
 * HTTP adapter for a community's rules, tags, events, and pins. Thin by
 * design — no business logic.
 */

function eventId(res: Parameters<RequestHandler>[1]): string {
  return validated<CommunityChildParam>(res, "Params").id;
}

/* ── Rules ──────────────────────────────────────────────────────────────── */

export const replaceRules: RequestHandler = async (req, res) => {
  const community = await resources.replaceRules(
    slugFrom(res),
    actorFrom(req),
    (req.body as ReplaceRulesInput).rules,
  );

  res.json(successResponse({ community }, "Rules updated"));
};

/* ── Tags ───────────────────────────────────────────────────────────────── */

export const replaceTags: RequestHandler = async (req, res) => {
  const community = await resources.replaceTags(
    slugFrom(res),
    actorFrom(req),
    (req.body as ReplaceTagsInput).tags,
  );

  res.json(successResponse({ community }, "Tags updated"));
};

/* ── Events ─────────────────────────────────────────────────────────────── */

export const listEvents: RequestHandler = async (req, res) => {
  const query = validated<EventListQuery>(res, "Query");
  const events = await resources.listEvents(
    slugFrom(res),
    viewerFrom(req),
    query.includePast,
    query.limit,
  );

  res.json(successResponse({ events }, "Events retrieved"));
};

export const createEvent: RequestHandler = async (req, res) => {
  const event = await resources.createEvent(
    slugFrom(res),
    actorFrom(req),
    req.body as CreateEventInput,
  );

  res.status(201).json(successResponse({ event }, "Event created"));
};

export const updateEvent: RequestHandler = async (req, res) => {
  const event = await resources.updateEvent(
    slugFrom(res),
    eventId(res),
    actorFrom(req),
    req.body as UpdateEventInput,
  );

  res.json(successResponse({ event }, "Event updated"));
};

export const deleteEvent: RequestHandler = async (req, res) => {
  const result = await resources.deleteEvent(slugFrom(res), eventId(res), actorFrom(req));

  res.json(successResponse(result, "Event deleted"));
};

/* ── Pins ───────────────────────────────────────────────────────────────── */

export const listPins: RequestHandler = async (req, res) => {
  const pinnedPostIds = await resources.listPinnedPosts(slugFrom(res), viewerFrom(req));

  res.json(successResponse({ pinnedPostIds }, "Pinned posts retrieved"));
};

export const pinPost: RequestHandler = async (req, res) => {
  const result = await resources.pinPost(
    slugFrom(res),
    actorFrom(req),
    (req.body as PinPostInput).postId,
  );

  res.status(201).json(successResponse(result, "Post pinned"));
};

export const unpinPost: RequestHandler = async (req, res) => {
  const result = await resources.unpinPost(slugFrom(res), actorFrom(req), eventId(res));

  res.json(successResponse(result, "Post unpinned"));
};
