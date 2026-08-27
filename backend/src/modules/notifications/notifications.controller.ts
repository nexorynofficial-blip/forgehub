import type { Request, RequestHandler } from "express";

import { validated } from "../../middleware/validation.middleware.js";
import { successResponse } from "../../utils/response.js";
import { requireUser } from "../users/users.controller.js";
import * as service from "./notifications.service.js";
import type {
  NotificationIdParam,
  NotificationListQuery,
} from "./notifications.schema.js";

/**
 * HTTP adapter for the notifications module (ARCHITECTURE §4–5).
 *
 * Translates between HTTP and the service and nothing else.
 *
 * Note what no handler here does: read a user id from anywhere. Every one
 * passes `actorFrom(req)`, resolved from the verified access token, and the
 * service has no parameter for whose notifications to touch. There is
 * therefore no request — well-formed or otherwise — that reads or mutates
 * another user's notifications, which is a stronger guarantee than a check
 * would give.
 *
 * There is also no create handler. Notifications are produced by the server in
 * response to domain events, never posted by a client.
 */

function actorFrom(req: Request): service.Actor {
  return { id: requireUser(req).id };
}

export const list: RequestHandler = async (req, res) => {
  const page = await service.list(
    actorFrom(req),
    validated<NotificationListQuery>(res, "Query"),
  );

  res.json(successResponse(page, "Notifications retrieved"));
};

export const getUnreadCount: RequestHandler = async (req, res) => {
  const unread = await service.getUnreadCount(actorFrom(req));
  res.json(successResponse(unread, "Unread count retrieved"));
};

export const markRead: RequestHandler = async (req, res) => {
  const { id } = validated<NotificationIdParam>(res, "Params");
  const notification = await service.markRead(id, actorFrom(req));

  res.json(successResponse({ notification }, "Notification marked as read"));
};

export const markAllRead: RequestHandler = async (req, res) => {
  const result = await service.markAllRead(actorFrom(req));
  res.json(successResponse(result, "Notifications marked as read"));
};
