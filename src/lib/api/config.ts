/**
 * Where the backend lives.
 *
 * Read once, from `NEXT_PUBLIC_API_URL`, so no service file ever hardcodes a
 * host. The fallback matches the backend's own `.env.example` defaults
 * (`PORT=4000`, API mounted at `/api/v1`), which keeps a fresh clone working
 * with no `.env.local` at all — see `.env.example` at the repo root.
 */
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";

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
