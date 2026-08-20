import type { Request, RequestHandler } from "express";

import { validated } from "../../middleware/validation.middleware.js";
import { auditContextFromRequest } from "../../utils/audit.js";
import { AppError } from "../../utils/errors.js";
import { successResponse } from "../../utils/response.js";
import * as usersService from "./users.service.js";
import type {
  UpdateNotificationPreferenceInput,
  UpdateProfileInput,
  UpdateSettingsInput,
  UpdateUsernameInput,
  UsernameParam,
} from "./users.schema.js";

/**
 * HTTP adapter for the users module (BACKEND_ARCHITECTURE.md §4–5).
 *
 * Translates between HTTP and the service and nothing else. Note that every
 * mutating handler passes `requireUser(req).id` — there is no path where a
 * body or path value selects *whose* record is written.
 */

function requireUser(req: Request): NonNullable<Request["user"]> {
  if (!req.user) {
    // Unreachable behind `requireAuth`; asserted so the types stay honest.
    throw AppError.authentication("Authentication required");
  }
  return req.user;
}

/** Viewer context for visibility decisions; anonymous when unauthenticated. */
function viewerFrom(req: Request): usersService.Viewer {
  return req.user ? { id: req.user.id, role: req.user.role } : usersService.ANONYMOUS;
}

export const getCurrentUser: RequestHandler = async (req, res) => {
  const user = await usersService.getCurrentUser(requireUser(req).id);
  res.json(successResponse({ user }, "Current user retrieved"));
};

export const getByUsername: RequestHandler = async (req, res) => {
  const { username } = validated<UsernameParam>(res, "Params");
  const result = await usersService.getProfileByUsername(username, viewerFrom(req));

  res.json(
    successResponse(
      { user: result.profile, relationship: result.relationship },
      "Profile retrieved",
    ),
  );
};

export const getAchievements: RequestHandler = async (req, res) => {
  const { username } = validated<UsernameParam>(res, "Params");
  const result = await usersService.getAchievements(username, viewerFrom(req));

  res.json(successResponse(result, "Achievements retrieved"));
};

export const updateProfile: RequestHandler = async (req, res) => {
  const user = await usersService.updateProfile(
    requireUser(req).id,
    req.body as UpdateProfileInput,
    auditContextFromRequest(req),
  );

  res.json(successResponse({ user }, "Profile updated"));
};

export const updateUsername: RequestHandler = async (req, res) => {
  const { username } = req.body as UpdateUsernameInput;
  const result = await usersService.updateUsername(
    requireUser(req).id,
    username,
    auditContextFromRequest(req),
  );

  res.json(successResponse(result, "Username updated"));
};

export const getSettings: RequestHandler = async (req, res) => {
  const settings = await usersService.getSettings(requireUser(req).id);
  res.json(successResponse({ settings }, "Settings retrieved"));
};

export const updateSettings: RequestHandler = async (req, res) => {
  const settings = await usersService.updateSettings(
    requireUser(req).id,
    req.body as UpdateSettingsInput,
    auditContextFromRequest(req),
  );

  res.json(successResponse({ settings }, "Settings updated"));
};

export const getNotificationPreferences: RequestHandler = async (req, res) => {
  const preferences = await usersService.getNotificationPreferences(requireUser(req).id);
  res.json(successResponse({ preferences }, "Notification preferences retrieved"));
};

export const updateNotificationPreference: RequestHandler = async (req, res) => {
  const preferences = await usersService.updateNotificationPreference(
    requireUser(req).id,
    req.body as UpdateNotificationPreferenceInput,
  );

  res.json(successResponse({ preferences }, "Notification preference updated"));
};

export { requireUser, viewerFrom };
