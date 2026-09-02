/**
 * The one place the frontend talks to the backend.
 *
 * Everything that is the same on every call lives here: the base URL, JSON
 * encoding, the `Authorization` header, cookie credentials, unwrapping the
 * backend envelope, turning failures into `ApiError`, and the access-token
 * refresh dance. Services above this layer describe *what* they want; nothing
 * above this layer sees an envelope or a bearer token.
 */

import { apiUrl } from "./config";
import {
  ApiError,
  statusFallbackMessage,
  type ApiErrorCode,
  type ApiErrorDetail,
} from "./errors";
import {
  clearAccessToken,
  getAccessToken,
  notifySessionExpired,
  setAccessToken,
} from "./token-store";

/* ── Wire format ──────────────────────────────────────────────────────────── */

/**
 * `backend/src/utils/response.ts` returns a deliberate superset:
 * `{ success, data, message, error }`. The frontend's own `ApiResponse` type
 * (`src/types/common.ts`) reads `data`/`error`, so both halves are present and
 * neither side had to change.
 */
interface SuccessEnvelope<T> {
  success: true;
  data: T;
  message: string;
  error: null;
}

interface ErrorEnvelope {
  success: false;
  data: null;
  error: { code: string; message: string; details?: ApiErrorDetail[] };
}

type Envelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Serialised as JSON. Omit for GET/DELETE. */
  body?: unknown;
  /** Appended as a query string; `undefined`/`null` entries are dropped. */
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  /**
   * Never attempt a token refresh for this request.
   *
   * Set on `/auth/refresh` itself — otherwise a failing refresh would trigger
   * a refresh, which would fail, which would trigger a refresh.
   */
  skipAuthRefresh?: boolean;
}

/** Internal marker: this call is already the one-and-only retry. */
interface InternalOptions extends RequestOptions {
  retried?: boolean;
}

/* ── Response parsing ─────────────────────────────────────────────────────── */

async function readEnvelope<T>(response: Response): Promise<Envelope<T> | null> {
  // A 204, or a proxy answering with HTML, must not blow up as a parse error.
  const text = await response.text();
  if (text.length === 0) return null;

  try {
    return JSON.parse(text) as Envelope<T>;
  } catch {
    return null;
  }
}

function toApiError(response: Response, envelope: Envelope<unknown> | null): ApiError {
  if (envelope && envelope.success === false) {
    return new ApiError(
      response.status,
      envelope.error.code as ApiErrorCode,
      envelope.error.message,
      envelope.error.details ?? [],
    );
  }

  // No envelope: something between us and the app answered (proxy, gateway).
  return new ApiError(
    response.status,
    "INTERNAL_ERROR",
    statusFallbackMessage(
      response.status,
      `Request failed (${String(response.status)}).`,
    ),
  );
}

/* ── Single-flight refresh ────────────────────────────────────────────────── */

export interface RefreshPayload {
  accessToken: string;
  /** The refresh *cookie* lifetime — not the access token's. See auth-service. */
  expiresIn: number;
  /** Shaped by the backend's `UserView`; narrowed by the auth service. */
  user: unknown;
}

/**
 * The in-flight refresh, if there is one.
 *
 * Three requests expiring together must produce **one** `POST /auth/refresh`,
 * not three. The backend rotates the refresh token on every use, so three
 * concurrent rotations would race and two of them would present a token that
 * had already been spent — logging the user out mid-session.
 */
let refreshInFlight: Promise<RefreshPayload | null> | null = null;

async function performRefresh(): Promise<RefreshPayload | null> {
  try {
    // `skipAuthRefresh` is what stops this from recursing into itself.
    const payload = await request<RefreshPayload>("/auth/refresh", {
      method: "POST",
      skipAuthRefresh: true,
    });
    setAccessToken(payload.accessToken);
    return payload;
  } catch {
    // Any failure here means the refresh cookie is gone, expired, or already
    // spent. There is no second chance to try, so the session is over.
    clearAccessToken();
    notifySessionExpired();
    return null;
  }
}

/**
 * Refreshes the access token, coalescing concurrent callers onto one request.
 *
 * Also used directly by `AuthProvider` for startup bootstrap, so a reload that
 * races a data fetch still issues only one refresh.
 */
export function refreshSession(): Promise<RefreshPayload | null> {
  refreshInFlight ??= performRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/* ── The request itself ───────────────────────────────────────────────────── */

function buildUrl(path: string, query: RequestOptions["query"]): string {
  const url = apiUrl(path);
  if (!query) return url;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }

  const serialised = params.toString();
  return serialised.length > 0 ? `${url}?${serialised}` : url;
}

async function request<T>(path: string, options: InternalOptions = {}): Promise<T> {
  const { method = "GET", body, query, signal, skipAuthRefresh, retried } = options;

  // Read the token *now*, not when this module was evaluated — a closure over
  // an old value would keep sending a token the refresh already replaced.
  const token = getAccessToken();

  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      headers,
      // The refresh token is an httpOnly cookie the browser must attach on its
      // own; JS neither reads nor sets it.
      credentials: "include",
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    // An aborted request is a caller decision, not a transport failure.
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(0, "NETWORK_ERROR", "Could not reach the server.");
  }

  const envelope = await readEnvelope<T>(response);

  if (response.ok && envelope && envelope.success) {
    return envelope.data;
  }

  if (response.ok) {
    // 2xx that carried no usable envelope — treat as an empty success.
    return undefined as T;
  }

  /*
   * The single 401 recovery path: refresh once, retry once, stop.
   *
   * Only attempted when a token was actually sent. A 401 with no token means
   * the caller is simply not signed in (bootstrap owns that case), and
   * refreshing on every anonymous 401 would hammer the endpoint.
   */
  const canRetry =
    response.status === 401 && !skipAuthRefresh && !retried && token !== null;

  if (canRetry) {
    const refreshed = await refreshSession();
    if (refreshed) {
      return request<T>(path, { ...options, retried: true });
    }
  }

  throw toApiError(response, envelope);
}

/* ── Public surface ───────────────────────────────────────────────────────── */

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, "method" | "body">) =>
    request<T>(path, { ...options, method: "GET" }),

  post: <T>(
    path: string,
    body?: unknown,
    options?: Omit<RequestOptions, "method" | "body">,
  ) => request<T>(path, { ...options, method: "POST", body }),

  patch: <T>(
    path: string,
    body?: unknown,
    options?: Omit<RequestOptions, "method" | "body">,
  ) => request<T>(path, { ...options, method: "PATCH", body }),

  put: <T>(
    path: string,
    body?: unknown,
    options?: Omit<RequestOptions, "method" | "body">,
  ) => request<T>(path, { ...options, method: "PUT", body }),

  delete: <T>(path: string, options?: Omit<RequestOptions, "method" | "body">) =>
    request<T>(path, { ...options, method: "DELETE" }),
};
