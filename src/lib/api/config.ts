import { API_BASE_URL } from "@/lib/env";

/**
 * Where the backend lives.
 *
 * The value itself comes from `lib/env.ts`, which is the single validated
 * source of truth for both public URLs — a second `process.env` read here
 * would be a second place for the localhost fallback to reappear. Re-exported
 * rather than re-derived so `lib/api`'s public surface is unchanged.
 */
export { API_BASE_URL };

/**
 * Builds an absolute URL from an API-relative path.
 *
 * Paths are written the way the backend documents them (`/auth/login`), so a
 * leading slash is normalised rather than required.
 */
export function apiUrl(path: string): string {
  const base = API_BASE_URL.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}
