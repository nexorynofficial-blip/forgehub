/**
 * One error type for every backend failure.
 *
 * Components branch on `status` or `code`, never on message text — the whole
 * point of carrying both is that "was this a conflict?" is a comparison, not a
 * string search.
 */

/** Field-level detail, as `backend/src/utils/errors.ts` emits it. */
export interface ApiErrorDetail {
  field: string;
  message: string;
}

/** The error codes the backend can return (`backend/src/utils/errors.ts`). */
export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "AUTHENTICATION_ERROR"
  | "AUTHORIZATION_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "DATABASE_ERROR"
  | "INTERNAL_ERROR"
  | "BAD_REQUEST"
  | "PAYLOAD_TOO_LARGE"
  | "SERVICE_UNAVAILABLE"
  /** Client-side only: the request never reached the backend. */
  | "NETWORK_ERROR";

export class ApiError extends Error {
  /** HTTP status, or 0 when the request never completed. */
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details: ApiErrorDetail[];

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    details: ApiErrorDetail[] = [],
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** The request never reached the backend (offline, DNS, CORS, timeout). */
  get isNetworkError(): boolean {
    return this.status === 0;
  }

  /** Field-level validation failure — `details` is worth rendering. */
  get isValidationError(): boolean {
    return this.status === 422 || this.code === "VALIDATION_ERROR";
  }

  /** Not signed in, or the session is gone. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  /** Signed in, but not allowed — includes banned and suspended accounts. */
  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isConflict(): boolean {
    return this.status === 409;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  /** The backend broke, or is unreachable/unhealthy. */
  get isServerError(): boolean {
    return this.status >= 500;
  }
}

/**
 * Fallbacks for the cases where a backend message would be unhelpful or
 * absent. The backend's own message is preferred whenever it exists: it is
 * written for users and is already safe to display (`errorResponse` never
 * carries a stack trace).
 */
const STATUS_FALLBACK: Record<number, string> = {
  400: "That request could not be processed.",
  401: "Your session has expired. Please sign in again.",
  403: "You do not have access to this.",
  404: "We could not find what you were looking for.",
  409: "That conflicts with something that already exists.",
  413: "That upload is too large.",
  422: "Please check the highlighted fields and try again.",
  429: "Too many requests — please wait a moment and try again.",
  500: "Something went wrong on our end. Please try again.",
  503: "The service is temporarily unavailable. Please try again shortly.",
};

/**
 * A sentence safe to put in a toast or inline error.
 *
 * Never returns raw JSON, and never an empty string.
 */
export function apiErrorMessage(
  error: unknown,
  fallback = "Something went wrong.",
): string {
  if (error instanceof ApiError) {
    if (error.isNetworkError) {
      return "Could not reach the server. Check your connection and try again.";
    }
    if (error.message.trim().length > 0) return error.message;
    return STATUS_FALLBACK[error.status] ?? fallback;
  }
  return fallback;
}

export function statusFallbackMessage(status: number, fallback: string): string {
  return STATUS_FALLBACK[status] ?? fallback;
}
