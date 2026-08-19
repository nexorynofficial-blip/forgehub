import { Prisma } from "@prisma/client";
import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";

import { isProduction } from "../config/env.js";
import { AppError, ErrorCode, isAppError, type ErrorDetail } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { errorResponse } from "../utils/response.js";

/** Body-parser attaches these when a request exceeds the configured limit. */
interface BodyParserError extends Error {
  type?: string;
  status?: number;
  statusCode?: number;
}

function zodToDetails(error: ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({
    field: issue.path.join(".") || "(root)",
    message: issue.message,
  }));
}

/**
 * Normalizes anything thrown anywhere in the stack into an `AppError`.
 * Unknown errors collapse to a generic INTERNAL_ERROR so implementation
 * details (driver messages, file paths) never reach a client.
 */
function normalize(error: unknown): AppError {
  if (isAppError(error)) return error;

  if (error instanceof ZodError) {
    return AppError.validation("Request validation failed", zodToDetails(error));
  }

  // Prisma failures map to intent-revealing codes; the driver's own message is
  // kept as `cause` for logs only (TRD §16: never leak database errors).
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      return AppError.conflict("A record with these values already exists");
    }
    if (error.code === "P2025") {
      return AppError.notFound("Resource not found");
    }
    return AppError.database("A database error occurred", error);
  }

  if (
    error instanceof Prisma.PrismaClientInitializationError ||
    error instanceof Prisma.PrismaClientRustPanicError
  ) {
    return AppError.serviceUnavailable("Database is unavailable");
  }

  if (error instanceof Error) {
    const candidate = error as BodyParserError;

    if (candidate.type === "entity.too.large") {
      return new AppError(ErrorCode.PAYLOAD_TOO_LARGE, "Request body is too large", {
        cause: error,
      });
    }

    // Malformed JSON — body-parser throws a SyntaxError with a status.
    if (error instanceof SyntaxError && candidate.status === 400) {
      return AppError.badRequest("Malformed JSON in request body");
    }

    return AppError.internal("An unexpected error occurred", error);
  }

  return AppError.internal("An unexpected error occurred", error);
}

/**
 * Terminal error middleware. Must be registered last, and must keep all four
 * parameters — Express identifies error handlers by arity.
 */
export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  const appError = normalize(error);

  const logPayload = {
    err: appError.cause ?? appError,
    code: appError.code,
    status: appError.status,
    method: req.method,
    path: req.originalUrl,
    requestId: res.locals["requestId"] as string | undefined,
    // Populated by the auth middleware in a later phase (TRD §30).
    userId: res.locals["userId"] as string | undefined,
  };

  // 5xx means we broke; 4xx means the caller did. Only the former is an alert.
  if (appError.status >= 500) {
    logger.error(logPayload, appError.message);
  } else {
    logger.warn(logPayload, appError.message);
  }

  // Never surface an internal failure's real message to a client in prod.
  const clientMessage =
    isProduction && appError.status >= 500
      ? "An unexpected error occurred"
      : appError.message;

  if (res.headersSent) {
    // Response already streaming — hand off so Express can destroy the socket.
    next(error);
    return;
  }

  res
    .status(appError.status)
    .json(errorResponse(appError.code, clientMessage, appError.details));
};

/** Catch-all for unmatched routes, so 404s use the same envelope as anything else. */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(AppError.notFound(`Route ${req.method} ${req.originalUrl} not found`));
};
