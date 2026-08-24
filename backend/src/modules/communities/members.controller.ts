import type { RequestHandler } from "express";

import { validated } from "../../middleware/validation.middleware.js";
import { auditContextFromRequest } from "../../utils/audit.js";
import { successResponse } from "../../utils/response.js";
import { viewerFrom } from "../users/users.controller.js";
import { actorFrom, cursorQuery, slugFrom } from "./communities.controller.js";
import * as membersService from "./members.service.js";
import type {
  AddMemberInput,
  CommunityMemberParam,
  MemberRoleInput,
  TransferOwnershipInput,
} from "./communities.schema.js";

/** HTTP adapter for community membership. Thin by design — no business logic. */

function memberTarget(res: Parameters<RequestHandler>[1]): {
  slug: string;
  username: string;
} {
  const params = validated<CommunityMemberParam>(res, "Params");
  return { slug: params.slug, username: params.username };
}

export const list: RequestHandler = async (req, res) => {
  const query = cursorQuery(res);
  const page = await membersService.list(
    slugFrom(res),
    viewerFrom(req),
    query.cursor,
    query.limit,
  );

  res.json(successResponse(page, "Members retrieved"));
};

export const listModerators: RequestHandler = async (req, res) => {
  const moderators = await membersService.listModerators(slugFrom(res), viewerFrom(req));

  res.json(successResponse({ moderators }, "Moderators retrieved"));
};

export const join: RequestHandler = async (req, res) => {
  const viewer = await membersService.join(slugFrom(res), actorFrom(req));

  res.status(201).json(successResponse({ viewer }, "Joined community"));
};

export const leave: RequestHandler = async (req, res) => {
  const result = await membersService.leave(slugFrom(res), actorFrom(req));

  res.json(successResponse(result, "Left community"));
};

export const add: RequestHandler = async (req, res) => {
  const body = req.body as AddMemberInput;
  const member = await membersService.add(
    slugFrom(res),
    actorFrom(req),
    body.username,
    body.role,
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
    (req.body as MemberRoleInput).role,
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

export const transfer: RequestHandler = async (req, res) => {
  const moderators = await membersService.transfer(
    slugFrom(res),
    actorFrom(req),
    (req.body as TransferOwnershipInput).username,
    auditContextFromRequest(req),
  );

  res.json(successResponse({ moderators }, "Ownership transferred"));
};
