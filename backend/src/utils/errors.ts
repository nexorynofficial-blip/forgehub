/**
 * Structured application errors (BACKEND_TRD.md §16, BACKEND_ARCHITECTURE.md §6).
 *
 * Errors flow: Service → AppError → error middleware → structured response.
 * Clients branch on `error.code`, never on `error.message` (wording is free
 * to change); the codes below are therefore part of the public API contract.
 */

/** Canonical error codes. The first eight are the categories named in TRD §16. */
export const ErrorCode = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  AUTHENTICATION_ERROR: "AUTHENTICATION_ERROR",
  AUTHORIZATION_ERROR: "AUTHORIZATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  DATABASE_ERROR: "DATABASE_ERROR",
  INTERNAL_ERROR: "INTERNAL_ERROR",

  /* Transport-level cases the eight categories above do not cover. */
  BAD_REQUEST: "BAD_REQUEST",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Default HTTP status per code, so call sites rarely pass one explicitly. */
export const ERROR_STATUS: Record<ErrorCodeValue, number> = {
  [ErrorCode.VALIDATION_ERROR]: 422,
  [ErrorCode.AUTHENTICATION_ERROR]: 401,
  [ErrorCode.AUTHORIZATION_ERROR]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.DATABASE_ERROR]: 500,
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.BAD_REQUEST]: 400,
  [ErrorCode.PAYLOAD_TOO_LARGE]: 413,
  [ErrorCode.SERVICE_UNAVAILABLE]: 503,
};

/**
 * Field-level failure detail. TRD §7 types `details` loosely as an object;
 * an array of field/message pairs is a concrete shape that serializes into
 * that slot and is what a form needs to highlight the right inputs.
 */
export interface ErrorDetail {
  field: string;
  message: string;
}

interface AppErrorOptions {
  status?: number;
  details?: ErrorDetail[];
  /** Original error, kept for logging only — never serialized to a client. */
  cause?: unknown;
}

/**
 * An error the API raised deliberately, with a known shape and status.
 *
 * The distinction that matters: `AppError` is *expected* (a 404, a failed
 * validation) and its message is safe to show a client. Anything else
 * reaching the error middleware is unexpected, and its message is replaced
 * with a generic one so internals never leak.
 */
export class AppError extends Error {
  readonly code: ErrorCodeValue;
  readonly status: number;
  readonly details: ErrorDetail[] | undefined;
  /** Always true — distinguishes deliberate errors from crashes. */
  readonly isOperational = true;

  constructor(code: ErrorCodeValue, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AppError";
    this.code = code;
    this.status = options.status ?? ERROR_STATUS[code];
    this.details = options.details;
    Error.captureStackTrace(this, AppError);
  }

  static badRequest(message = "Bad request", details?: ErrorDetail[]): AppError {
    return new AppError(ErrorCode.BAD_REQUEST, message, details ? { details } : {});
  }

  static validation(message = "Validation failed", details?: ErrorDetail[]): AppError {
    return new AppError(ErrorCode.VALIDATION_ERROR, message, details ? { details } : {});
  }

  /** 401 — identity could not be established (TRD §16 AUTHENTICATION_ERROR). */
  static authentication(message = "Authentication required"): AppError {
    return new AppError(ErrorCode.AUTHENTICATION_ERROR, message);
  }

  /** 403 — identity known, permission denied (TRD §16 AUTHORIZATION_ERROR). */
  static authorization(message = "You do not have access to this resource"): AppError {
    return new AppError(ErrorCode.AUTHORIZATION_ERROR, message);
  }

  static notFound(message = "Resource not found"): AppError {
    return new AppError(ErrorCode.NOT_FOUND, message);
  }

  static conflict(message = "Resource already exists"): AppError {
    return new AppError(ErrorCode.CONFLICT, message);
  }

  static rateLimited(message = "Too many requests"): AppError {
    return new AppError(ErrorCode.RATE_LIMITED, message);
  }

  /** Wraps a driver/ORM failure without leaking its message to the client. */
  static database(message = "A database error occurred", cause?: unknown): AppError {
    return new AppError(
      ErrorCode.DATABASE_ERROR,
      message,
      cause !== undefined ? { cause } : {},
    );
  }

  static serviceUnavailable(message = "Service temporarily unavailable"): AppError {
    return new AppError(ErrorCode.SERVICE_UNAVAILABLE, message);
  }

  static internal(message = "An unexpected error occurred", cause?: unknown): AppError {
    return new AppError(
      ErrorCode.INTERNAL_ERROR,
      message,
      cause !== undefined ? { cause } : {},
    );
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
