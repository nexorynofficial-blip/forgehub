import { SOCKET_URL } from "@/lib/env";

/**
 * Where the Socket.IO server lives.
 *
 * The server **root**, not the API prefix: Socket.IO mounts its own
 * `/socket.io` path on the same HTTP server that serves `/api/v1`, so pointing
 * this at `NEXT_PUBLIC_API_URL` would produce `/api/v1/socket.io` and fail the
 * handshake. `lib/env.ts` validates exactly that and is the one place either
 * public URL is read, so there is no separate fallback here to drift from it.
 */
export { SOCKET_URL };
