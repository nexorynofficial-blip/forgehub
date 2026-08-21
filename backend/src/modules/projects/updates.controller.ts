import type { RequestHandler } from "express";

import { validated } from "../../middleware/validation.middleware.js";
import { successResponse } from "../../utils/response.js";
import { viewerFrom } from "../users/users.controller.js";
import { actorFrom, slugFrom } from "./projects.controller.js";
import * as updatesService from "./updates.service.js";
import type {
  ChildParam,
  CreateUpdateInput,
  CursorQuery,
  EditUpdateInput,
} from "./projects.schema.js";

/** HTTP adapter for the project changelog. */

function childId(res: Parameters<RequestHandler>[1]): string {
  return validated<ChildParam>(res, "Params").id;
}

export const list: RequestHandler = async (req, res) => {
  const query = validated<CursorQuery>(res, "Query");
  const page = await updatesService.list(slugFrom(res), viewerFrom(req), {
    cursor: query.cursor,
    limit: query.limit,
  });

  res.json(successResponse(page, "Updates retrieved"));
};

export const create: RequestHandler = async (req, res) => {
  const update = await updatesService.create(
    slugFrom(res),
    actorFrom(req),
    req.body as CreateUpdateInput,
  );

  res.status(201).json(successResponse({ update }, "Update posted"));
};

export const edit: RequestHandler = async (req, res) => {
  const update = await updatesService.edit(
    slugFrom(res),
    actorFrom(req),
    childId(res),
    req.body as EditUpdateInput,
  );

  res.json(successResponse({ update }, "Update edited"));
};

export const remove: RequestHandler = async (req, res) => {
  const result = await updatesService.remove(slugFrom(res), actorFrom(req), childId(res));
  res.json(successResponse(result, "Update deleted"));
};
