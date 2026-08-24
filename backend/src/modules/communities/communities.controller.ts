import type { Request, RequestHandler } from "express";

import { validated } from "../../middleware/validation.middleware.js";
import { auditContextFromRequest } from "../../utils/audit.js";
import { successResponse } from "../../utils/response.js";
import { requireUser, viewerFrom } from "../users/users.controller.js";
import type { UsernameParam } from "../users/users.schema.js";
import * as service from "./communities.service.js";
import type {
  CommunityCursorQuery,
  CommunityListQuery,
  CommunitySlugParam,
  CreateCommunityInput,
  UpdateCommunityInput,
} from "./communities.schema.js";

/**
 * HTTP adapter for the communities module (BACKEND_ARCHITECTURE.md §4–5).
 *
 * Translates between HTTP and the services and nothing else. Every mutating
 * handler passes `actorFrom(req)` — identity from the verified access token —
 * so no body or path value can select whose community is written.
 */

export function actorFrom(req: Request): service.Actor {
  const user = requireUser(req);
  return { id: user.id, role: user.role };
}

export function slugFrom(res: Parameters<RequestHandler>[1]): string {
  return validated<CommunitySlugParam>(res, "Params").slug;
}

export function cursorQuery(res: Parameters<RequestHandler>[1]): CommunityCursorQuery {
  return validated<CommunityCursorQuery>(res, "Query");
}

/* ── Discovery and detail ────────────────────────────────────────────────── */

export const list: RequestHandler = async (req, res) => {
  const page = await service.list(
    viewerFrom(req),
    validated<CommunityListQuery>(res, "Query"),
  );

  res.json(successResponse(page, "Communities retrieved"));
};

export const getBySlug: RequestHandler = async (req, res) => {
  const result = await service.getBySlug(slugFrom(res), viewerFrom(req));

  res.json(
    successResponse(
      { community: result.community, viewer: result.viewer },
      "Community retrieved",
    ),
  );
};

export const create: RequestHandler = async (req, res) => {
  const community = await service.create(
    actorFrom(req),
    req.body as CreateCommunityInput,
    auditContextFromRequest(req),
  );

  res.status(201).json(successResponse({ community }, "Community created"));
};

export const update: RequestHandler = async (req, res) => {
  const community = await service.update(
    slugFrom(res),
    actorFrom(req),
    req.body as UpdateCommunityInput,
  );

  res.json(successResponse({ community }, "Community updated"));
};

export const remove: RequestHandler = async (req, res) => {
  const result = await service.remove(
    slugFrom(res),
    actorFrom(req),
    auditContextFromRequest(req),
  );

  res.json(successResponse(result, "Community deleted"));
};

/** `GET /users/:username/communities` — mounted on the user router. */
export const listByMember: RequestHandler = async (req, res) => {
  const { username } = validated<UsernameParam>(res, "Params");
  const query = cursorQuery(res);

  const page = await service.listByMember(
    username,
    viewerFrom(req),
    query.cursor,
    query.limit,
  );

  res.json(successResponse(page, "Communities retrieved"));
};
