import { validatePublicEnv } from "@/lib/env-contract";

/**
 * The resolved public environment — the one place either `NEXT_PUBLIC_*` URL
 * is read, for the whole frontend.
 *
 * The rules live in `env-contract.ts`; this file applies them. Evaluating at
 * module scope means a bad value fails while the bundle is being built, since
 * this module is reachable from every page through the API client, and fails
 * again in the browser against the inlined values.
 *
 * Both reads below are full static property accesses. Next.js inlines
 * `NEXT_PUBLIC_*` by literal text substitution, so `process.env[name]` would
 * not be replaced and would read `undefined` in the browser.
 *
 * The branch is deliberate rather than a ternary on a flag. `NODE_ENV` is
 * inlined too, so in a production build the development arm is statically
 * dead and the localhost strings below are dropped from the bundle entirely —
 * they cannot be shipped even as unreachable constants.
 */
const resolved =
  process.env.NODE_ENV === "production"
    ? validatePublicEnv({
        apiUrl: process.env.NEXT_PUBLIC_API_URL,
        socketUrl: process.env.NEXT_PUBLIC_SOCKET_URL,
        isProduction: true,
      })
    : validatePublicEnv({
        apiUrl: process.env.NEXT_PUBLIC_API_URL,
        socketUrl: process.env.NEXT_PUBLIC_SOCKET_URL,
        isProduction: false,
        // Matching the backend's own defaults (`backend/.env.example`:
        // `PORT=4000`, API mounted at `/api/v1`), so a fresh clone runs with
        // no `.env.local` at all.
        fallbacks: {
          apiUrl: "http://localhost:4000/api/v1",
          socketUrl: "http://localhost:4000",
        },
      });

/** Where the backend API is mounted, including the `/api/v1` prefix. */
export const API_BASE_URL = resolved.apiUrl;

/** The Socket.IO origin — the server root, without the API prefix. */
export const SOCKET_URL = resolved.socketUrl;
