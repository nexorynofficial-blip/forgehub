/**
 * Where the Socket.IO server lives.
 *
 * The server **root**, not the API prefix: Socket.IO mounts its own
 * `/socket.io` path on the same HTTP server that serves `/api/v1`, so pointing
 * this at `NEXT_PUBLIC_API_URL` would produce `/api/v1/socket.io` and fail the
 * handshake. Read from the environment for the same reason the API base URL is
 * — no host is hardcoded in a component or service.
 */
export const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL ?? "http://localhost:4000";
