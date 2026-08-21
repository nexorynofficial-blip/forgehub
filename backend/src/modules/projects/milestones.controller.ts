import type { RequestHandler } from "express";

import { validated } from "../../middleware/validation.middleware.js";
import { successResponse } from "../../utils/response.js";
import { viewerFrom } from "../users/users.controller.js";
import { actorFrom, slugFrom } from "./projects.controller.js";
import * as milestonesService from "./milestones.service.js";
import type {
  ChildParam,
  CreateMilestoneInput,
  UpdateMilestoneInput,
} from "./projects.schema.js";

/** HTTP adapter for the project roadmap. */

function childId(res: Parameters<RequestHandler>[1]): string {
  return validated<ChildParam>(res, "Params").id;
}

export const list: RequestHandler = async (req, res) => {
  const milestones = await milestonesService.list(slugFrom(res), viewerFrom(req));
  res.json(successResponse({ milestones }, "Milestones retrieved"));
};

export const create: RequestHandler = async (req, res) => {
  const result = await milestonesService.create(
    slugFrom(res),
    actorFrom(req),
    req.body as CreateMilestoneInput,
  );

  res.status(201).json(successResponse(result, "Milestone created"));
};

export const update: RequestHandler = async (req, res) => {
  const result = await milestonesService.update(
    slugFrom(res),
    actorFrom(req),
    childId(res),
    req.body as UpdateMilestoneInput,
  );

  res.json(successResponse(result, "Milestone updated"));
};

export const remove: RequestHandler = async (req, res) => {
  const result = await milestonesService.remove(
    slugFrom(res),
    actorFrom(req),
    childId(res),
  );

  res.json(successResponse(result, "Milestone deleted"));
};
