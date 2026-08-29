import type { Request, RequestHandler } from "express";

import { validated } from "../../middleware/validation.middleware.js";
import { auditContextFromRequest } from "../../utils/audit.js";
import { AppError } from "../../utils/errors.js";
import { paginatedResponse, successResponse } from "../../utils/response.js";
import * as service from "./admin.service.js";
import type {
  ListAuditLogsQuery,
  ListUsersQuery,
  UpdateUserRoleBody,
  UpdateUserStatusBody,
  UserIdParam,
} from "./admin.schema.js";

/**
 * HTTP adapter for the admin module (ARCHITECTURE §4–5).
 *
 * Translates between HTTP and the service and nothing else — no business
 * logic, no Prisma, no authorization decisions.
 *
 * Every handler resolves the administrator from `req.user`, which
 * `requireAuth` populated from a verified access token. No schema in this
 * module declares an `actorId`, so there is no request that performs an
 * administrative action under another administrator's name — and the target of
 * every mutation is a path parameter, never a body field, so the thing being
 * changed and the person changing it can never be confused.
 */

function actorFrom(req: Request): service.Actor {
  if (!req.user) {
    // Unreachable behind `requireAuth`; asserted so the types stay honest.
    throw AppError.authentication("Authentication required");
  }
  return { id: req.user.id, role: req.user.role };
}

export const listUsers: RequestHandler = async (req, res) => {
  const page = await service.listUsers(
    actorFrom(req),
    validated<ListUsersQuery>(res, "Query"),
  );

  res.json(paginatedResponse(page.users, page.pagination, "Users retrieved"));
};

export const updateUserRole: RequestHandler = async (req, res) => {
  const { id } = validated<UserIdParam>(res, "Params");
  const user = await service.updateUserRole(
    actorFrom(req),
    id,
    req.body as UpdateUserRoleBody,
    auditContextFromRequest(req),
  );

  res.json(successResponse({ user }, "Role updated"));
};

export const updateUserStatus: RequestHandler = async (req, res) => {
  const { id } = validated<UserIdParam>(res, "Params");
  const result = await service.updateUserStatus(
    actorFrom(req),
    id,
    req.body as UpdateUserStatusBody,
    auditContextFromRequest(req),
  );

  res.json(successResponse(result, "Status updated"));
};

export const getStats: RequestHandler = async (req, res) => {
  const stats = await service.getOverviewStats(actorFrom(req));
  res.json(successResponse(stats, "Platform statistics retrieved"));
};

export const getSignups: RequestHandler = async (req, res) => {
  const signups = await service.getWeeklySignups(actorFrom(req));
  res.json(successResponse({ signups }, "Weekly signups retrieved"));
};

export const getReportsByReason: RequestHandler = async (req, res) => {
  const reasons = await service.getReportsByReason(actorFrom(req));
  res.json(successResponse({ reasons }, "Report reasons retrieved"));
};

export const listAuditLogs: RequestHandler = async (req, res) => {
  const page = await service.listAuditLogs(
    actorFrom(req),
    validated<ListAuditLogsQuery>(res, "Query"),
  );

  res.json(paginatedResponse(page.logs, page.pagination, "Audit logs retrieved"));
};
