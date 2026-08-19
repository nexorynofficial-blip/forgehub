import type { ErrorCodeValue, ErrorDetail } from "./errors.js";

/**
 * The single response envelope for every `/api/v1` endpoint
 * (BACKEND_TRD.md §7).
 *
 * Compatibility note: the TRD specifies `{ success, data, message }` for
 * success and `{ success, error }` for failure, while the completed frontend
 * types its contract as `{ data, error }` (`src/types/common.ts`). The
 * envelopes below are a deliberate superset carrying every key both expect —
 * `success`/`message`/`pagination` for the TRD, `data`/`error` for the
 * frontend — so neither side needs to change.
 */

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface SuccessEnvelope<T> {
  success: true;
  data: T;
  message: string;
  error: null;
}

export interface PaginatedEnvelope<T> extends SuccessEnvelope<T[]> {
  pagination: Pagination;
}

export interface ErrorEnvelope {
  success: false;
  data: null;
  error: {
    code: ErrorCodeValue;
    message: string;
    /** Present only for field-level validation failures. */
    details?: ErrorDetail[];
  };
}

export type ApiEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export function successResponse<T>(
  data: T,
  message = "Operation completed successfully",
): SuccessEnvelope<T> {
  return { success: true, data, message, error: null };
}

/**
 * Collection response. TRD §8 forbids returning large collections unpaginated,
 * so list endpoints should build their response through this rather than
 * `successResponse` with a bare array.
 */
export function paginatedResponse<T>(
  data: T[],
  pagination: Pagination,
  message = "Operation completed successfully",
): PaginatedEnvelope<T> {
  return { success: true, data, message, error: null, pagination };
}

export function errorResponse(
  code: ErrorCodeValue,
  message: string,
  details?: ErrorDetail[],
): ErrorEnvelope {
  return {
    success: false,
    data: null,
    error: details && details.length > 0 ? { code, message, details } : { code, message },
  };
}
