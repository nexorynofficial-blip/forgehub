import type { RequestHandler } from "express";

import { validated } from "../../middleware/validation.middleware.js";
import { auditContextFromRequest } from "../../utils/audit.js";
import { paginatedResponse, successResponse } from "../../utils/response.js";
import { viewerFrom } from "../users/users.controller.js";
import { actorFrom, slugFrom } from "./projects.controller.js";
import * as membersService from "./members.service.js";
import type {
  AddMemberInput,
  MemberParam,
  OffsetQuery,
  UpdateMemberRoleInput,
} from "./projects.schema.js";

/** HTTP adapter for project membership. Thin by design — no business logic. */

function memberTarget(res: Parameters<RequestHandler>[1]): {
  slug: string;
  username: string;
} {
  const params = validated<MemberParam>(res, "Params");
  return { slug: params.slug, username: params.username };
}

export const list: RequestHandler = async (req, res) => {
  const query = validated<OffsetQuery>(res, "Query");
  const result = await membersService.list(slugFrom(res), viewerFrom(req), query);

  res.json(paginatedResponse(result.members, result.pagination, "Members retrieved"));
};

export const add: RequestHandler = async (req, res) => {
  const member = await membersService.add(
    slugFrom(res),
    actorFrom(req),
    req.body as AddMemberInput,
    auditContextFromRequest(req),
  );

  res.status(201).json(successResponse({ member }, "Member added"));
};

export const updateRole: RequestHandler = async (req, res) => {
  const { slug, username } = memberTarget(res);
  const member = await membersService.updateRole(
    slug,
    actorFrom(req),
    username,
    req.body as UpdateMemberRoleInput,
    auditContextFromRequest(req),
  );

  res.json(successResponse({ member }, "Member role updated"));
};

export const remove: RequestHandler = async (req, res) => {
  const { slug, username } = memberTarget(res);
  const result = await membersService.remove(
    slug,
    actorFrom(req),
    username,
    auditContextFromRequest(req),
  );

  res.json(successResponse(result, "Member removed"));
};
