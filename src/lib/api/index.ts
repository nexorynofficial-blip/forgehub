/** Barrel for the API layer, so services import from one place. */

export {
  api,
  refreshSession,
  type OffsetPage,
  type Pagination,
  type RefreshPayload,
  type RequestOptions,
} from "./client";
export { API_BASE_URL, apiUrl } from "./config";
export {
  ApiError,
  apiErrorMessage,
  type ApiErrorCode,
  type ApiErrorDetail,
} from "./errors";
export { applyApiFieldErrors, toFieldName } from "./form-errors";
export {
  clearAccessToken,
  getAccessToken,
  setAccessToken,
  setSessionExpiredHandler,
} from "./token-store";
