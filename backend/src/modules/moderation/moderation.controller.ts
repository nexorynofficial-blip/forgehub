import type { Request, RequestHandler } from "express";

import { validated } from "../../middleware/validation.middleware.js";
import { auditContextFromRequest } from "../../utils/audit.js";
import { AppError } from "../../utils/errors.js";
import { paginatedResponse, successResponse } from "../../utils/response.js";
import * as service from "./moderation.service.js";
import type {
  CreateActionBody,
  CreateReportBody,
  ListReportsQuery,
  ReportIdParam,
  UpdateReportBody,
} from "./moderation.schema.js";

/**
 * HTTP adapter for the moderation module (ARCHITECTURE §4–5).
 *
 * Translates between HTTP and the service and nothing else — no business
 * logic, no Prisma, no authorization decisions.
 *
 * Note what no handler here does: take an identity from anything except
 * `req.user`, which `requireAuth` populated from a verified access token.
 * `reporterId`, `reviewerId`, `moderatorId`, and `actorId` are not declared in
 * any schema, so Zod strips them before a body arrives, and no service
 * function has a parameter one of them could reach. There is therefore no
 * request — well-formed or otherwise — that files a report as somebody else or
 * signs a moderation action with another moderator's name.
 */

function actorFrom(req: Request): service.Actor {
  if (!req.user) {
    // Unreachable behind `requireAuth`; asserted so the types stay honest.
    throw AppError.authentication("Authentication required");
  }
  return { id: req.user.id, role: req.user.role };
}

export const createReport: RequestHandler = async (req, res) => {
  const report = await service.createReport(
    actorFrom(req),
    req.body as CreateReportBody,
    auditContextFromRequest(req),
  );

  res.status(201).json(successResponse({ report }, "Report submitted"));
};

export const listReports: RequestHandler = async (req, res) => {
  const page = await service.listReports(
    actorFrom(req),
    validated<ListReportsQuery>(res, "Query"),
  );

  res.json(paginatedResponse(page.reports, page.pagination, "Reports retrieved"));
};

export const getReport: RequestHandler = async (req, res) => {
  const { id } = validated<ReportIdParam>(res, "Params");
  const report = await service.getReport(actorFrom(req), id);

  res.json(successResponse({ report }, "Report retrieved"));
};

export const updateReport: RequestHandler = async (req, res) => {
  const { id } = validated<ReportIdParam>(res, "Params");
  const report = await service.reviewReport(
    actorFrom(req),
    id,
    req.body as UpdateReportBody,
    auditContextFromRequest(req),
  );

  res.json(successResponse({ report }, "Report updated"));
};

export const createAction: RequestHandler = async (req, res) => {
  const result = await service.createAction(
    actorFrom(req),
    req.body as CreateActionBody,
    auditContextFromRequest(req),
  );

  res.status(201).json(successResponse(result, "Moderation action recorded"));
};
