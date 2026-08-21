import type { Request, RequestHandler } from "express";

import { validated } from "../../middleware/validation.middleware.js";
import { auditContextFromRequest } from "../../utils/audit.js";
import { paginatedResponse, successResponse } from "../../utils/response.js";
import { requireUser, viewerFrom } from "../users/users.controller.js";
import type { UsernameParam } from "../users/users.schema.js";
import * as projectsService from "./projects.service.js";
import type {
  CreateProjectInput,
  OwnerProjectsQuery,
  ProjectListQuery,
  SlugParam,
  TransferOwnershipInput,
  TrendingQuery,
  UpdateProjectInput,
} from "./projects.schema.js";

/**
 * HTTP adapter for the projects module (BACKEND_ARCHITECTURE.md §4–5).
 *
 * Translates between HTTP and the service and nothing else. Every mutating
 * handler passes `actorFrom(req)` — identity resolved from the verified access
 * token — so there is no request shape in which a body or path value selects
 * *whose* project is written or who ends up owning it.
 */

/** An authenticated actor. Unreachable as null behind `requireAuth`. */
export function actorFrom(req: Request): projectsService.Actor {
  const user = requireUser(req);
  return { id: user.id, role: user.role };
}

export function slugFrom(res: Parameters<RequestHandler>[1]): string {
  return validated<SlugParam>(res, "Params").slug;
}

/* ── Discovery ──────────────────────────────────────────────────────────── */

export const list: RequestHandler = async (req, res) => {
  const query = validated<ProjectListQuery>(res, "Query");
  const result = await projectsService.list(viewerFrom(req), query);

  res.json(paginatedResponse(result.projects, result.pagination, "Projects retrieved"));
};

export const listTrending: RequestHandler = async (_req, res) => {
  const { limit } = validated<TrendingQuery>(res, "Query");
  const projects = await projectsService.listTrending(limit);

  res.json(successResponse({ projects }, "Trending projects retrieved"));
};

/**
 * An owner's projects. Mounted on the users router, because it is addressed as
 * a property of a profile — the same reasoning that put the follow routes
 * under `/users/:username`.
 */
export const listByOwner: RequestHandler = async (req, res) => {
  const { username } = validated<UsernameParam>(res, "Params");
  const query = validated<OwnerProjectsQuery>(res, "Query");
  const result = await projectsService.listByOwner(username, viewerFrom(req), query);

  res.json(paginatedResponse(result.projects, result.pagination, "Projects retrieved"));
};

/* ── Core CRUD ──────────────────────────────────────────────────────────── */

export const getBySlug: RequestHandler = async (req, res) => {
  const result = await projectsService.getBySlug(slugFrom(res), viewerFrom(req));

  res.json(
    successResponse(
      { project: result.project, viewer: result.viewer },
      "Project retrieved",
    ),
  );
};

export const create: RequestHandler = async (req, res) => {
  const project = await projectsService.create(
    actorFrom(req),
    req.body as CreateProjectInput,
    auditContextFromRequest(req),
  );

  res.status(201).json(successResponse({ project }, "Project created"));
};

export const update: RequestHandler = async (req, res) => {
  const project = await projectsService.update(
    slugFrom(res),
    actorFrom(req),
    req.body as UpdateProjectInput,
    auditContextFromRequest(req),
  );

  res.json(successResponse({ project }, "Project updated"));
};

export const remove: RequestHandler = async (req, res) => {
  const result = await projectsService.remove(
    slugFrom(res),
    actorFrom(req),
    auditContextFromRequest(req),
  );

  res.json(successResponse(result, "Project deleted"));
};

export const transferOwnership: RequestHandler = async (req, res) => {
  const project = await projectsService.transferOwnership(
    slugFrom(res),
    actorFrom(req),
    req.body as TransferOwnershipInput,
    auditContextFromRequest(req),
  );

  res.json(successResponse({ project }, "Ownership transferred"));
};
