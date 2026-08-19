import type { RequestHandler } from "express";
import type { ZodType } from "zod";

import { AppError, type ErrorDetail } from "../utils/errors.js";

/**
 * Request validation foundation (BACKEND_TRD.md §15). Feature modules define
 * their Zod schemas in `modules/<feature>/<feature>.schema.ts` and mount them
 * per route; this is the only place that knows how to run them and turn
 * failures into the standard error envelope.
 */

export interface RequestSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

type Segment = keyof RequestSchemas;

const SEGMENTS: Segment[] = ["body", "query", "params"];

/**
 * Validates the named request segments against their schemas.
 *
 * Parsed output replaces `req.body` (so downstream handlers get coerced,
 * stripped values rather than raw input). `req.query`/`req.params` are
 * getter-only in Express 5, so their parsed values are exposed on
 * `res.locals` instead of being reassigned.
 */
export function validate(schemas: RequestSchemas): RequestHandler {
  return (req, res, next) => {
    const details: ErrorDetail[] = [];

    for (const segment of SEGMENTS) {
      const schema = schemas[segment];
      if (!schema) continue;

      const result = schema.safeParse(req[segment]);

      if (!result.success) {
        for (const issue of result.error.issues) {
          details.push({
            field: [segment, ...issue.path].join("."),
            message: issue.message,
          });
        }
        continue;
      }

      if (segment === "body") {
        req.body = result.data;
      } else {
        res.locals[`validated${segment[0]!.toUpperCase()}${segment.slice(1)}`] =
          result.data;
      }
    }

    if (details.length > 0) {
      next(AppError.validation("Request validation failed", details));
      return;
    }

    next();
  };
}

/** Typed accessor for query/params validated above, avoiding `as` at call sites. */
export function validated<T>(
  res: { locals: Record<string, unknown> },
  segment: "Query" | "Params",
): T {
  return res.locals[`validated${segment}`] as T;
}
