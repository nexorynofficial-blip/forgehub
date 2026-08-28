import type { Request, RequestHandler } from "express";

import { validated } from "../../middleware/validation.middleware.js";
import { successResponse } from "../../utils/response.js";
import * as service from "./search.service.js";
import type { SearchQuery } from "./search.schema.js";

/**
 * HTTP adapter for the search module (BACKEND_ARCHITECTURE.md §4–5).
 *
 * Translates between HTTP and the service and nothing else — no business
 * logic, no Prisma, no visibility decisions.
 *
 * Note what this handler does *not* do: read a user id from anywhere except
 * `req.user`, which `optionalAuth` populated from a verified access token. A
 * `userId` in the query string is stripped by Zod before it arrives, and the
 * service has no parameter that could select a different viewer. There is
 * therefore no request — well-formed or otherwise — that evaluates search
 * visibility as somebody else.
 */

function viewerFrom(req: Request): service.Viewer {
  return req.user ? { id: req.user.id, role: req.user.role } : service.ANONYMOUS;
}

/**
 * `GET /search`.
 *
 * Always 200 with a grouped body. An empty result is an ordinary outcome, not
 * a 404: the query was understood and ran, and there was nothing visible to
 * return. A malformed query is a 422 from the validation middleware before
 * this handler is reached, and a search that would have matched something the
 * viewer may not see is indistinguishable from one that matched nothing —
 * which is the whole point.
 */
export const search: RequestHandler = async (req, res) => {
  const results = await service.search(
    viewerFrom(req),
    validated<SearchQuery>(res, "Query"),
  );

  res.json(successResponse(results, "Search completed"));
};
