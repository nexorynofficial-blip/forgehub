/**
 * The frontend's environment contract — the rules for both public URLs.
 *
 * ## Why this exists
 *
 * `NEXT_PUBLIC_*` values are **inlined into the browser bundle at build time**,
 * not read at startup. So a production build with the variables unset used to
 * bake in the localhost fallbacks, compile cleanly, deploy cleanly, pass a
 * health check — and then send every API call from a real browser to the
 * visitor's own machine. Nothing in the pipeline reported a problem, because
 * nothing had failed: the build did exactly what it was told.
 *
 * The fix is to make the omission an error rather than a default. In
 * development the localhost fallbacks stay, because a fresh clone with no
 * `.env.local` should still run.
 *
 * ## Why production takes no fallback at all
 *
 * `fallbacks` is absent from the production call rather than ignored inside
 * it. Two things follow. The rule "production has no fallback" becomes
 * structural instead of a branch that could be edited away — and, because the
 * only reference to the localhost strings then sits in a branch guarded by the
 * inlined `NODE_ENV`, a production build eliminates them entirely. The
 * compiled bundle contains no `localhost` at all, which makes grepping it a
 * real check rather than one that has to tell a live value from a dead
 * constant.
 *
 * ## Why the rules live apart from the values
 *
 * This module is deliberately **side-effect free**: it defines the rules and
 * reads nothing. `lib/env.ts` applies them once at module scope for the app,
 * and `next.config.ts` applies them again during `PHASE_PRODUCTION_BUILD`.
 * Importing a module that validated on load into `next.config.ts` would also
 * fire on `next start`, where the values are already baked into the bundle and
 * demanding them again is a false alarm.
 *
 * One implementation, two call sites, no duplicated rules.
 */

const API_URL_VAR = "NEXT_PUBLIC_API_URL";
const SOCKET_URL_VAR = "NEXT_PUBLIC_SOCKET_URL";

/** Hostnames that can only mean "this machine". */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

/** What a development build falls back to when a variable is unset. */
export interface PublicEnvFallbacks {
  apiUrl: string;
  socketUrl: string;
}

export interface PublicEnvSource {
  apiUrl: string | undefined;
  socketUrl: string | undefined;
  isProduction: boolean;
  /** Development only. A production source must not supply these. */
  fallbacks?: PublicEnvFallbacks;
}

/** Validates one URL variable, returning the value to use. */
export function resolvePublicUrl(
  name: string,
  raw: string | undefined,
  fallback: string | undefined,
  isProduction: boolean,
): string {
  const value = raw?.trim();

  if (!value) {
    if (!isProduction && fallback) return fallback;
    throw new Error(
      `${name} is not set, and a production build has no fallback for it. ` +
        `NEXT_PUBLIC_* values are inlined into the browser bundle at build time ` +
        `rather than read at startup, so this must be set in the BUILD ` +
        `environment — setting it only at runtime has no effect.`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `${name} must be an absolute URL including the scheme (received "${value}").`,
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must use http or https (received "${parsed.protocol}//").`);
  }

  if (isProduction && LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `${name} points at ${parsed.hostname}, which in a production bundle resolves to ` +
        `each visitor's own machine rather than your API. Set it to the public origin.`,
    );
  }

  return value;
}

/**
 * The socket URL is the server **root**, never the API prefix.
 *
 * Socket.IO mounts `/socket.io` on the same HTTP server that serves
 * `/api/v1`, so pointing this at the API URL produces `/api/v1/socket.io` and
 * the handshake fails with no useful message. Copying one variable into the
 * other is the obvious mistake, so it is worth naming.
 */
export function assertSocketUrlIsServerRoot(value: string): void {
  const { pathname } = new URL(value);

  if (pathname.replace(/\/+$/, "").length > 0) {
    throw new Error(
      `${SOCKET_URL_VAR} must be the server root with no path (received "${value}"). ` +
        `Socket.IO mounts /socket.io itself; a path here produces "${pathname}/socket.io" ` +
        `and the handshake fails.`,
    );
  }
}

/** Validates a whole environment at once. */
export function validatePublicEnv(source: PublicEnvSource): {
  apiUrl: string;
  socketUrl: string;
} {
  const apiUrl = resolvePublicUrl(
    API_URL_VAR,
    source.apiUrl,
    source.fallbacks?.apiUrl,
    source.isProduction,
  );
  const socketUrl = resolvePublicUrl(
    SOCKET_URL_VAR,
    source.socketUrl,
    source.fallbacks?.socketUrl,
    source.isProduction,
  );

  assertSocketUrlIsServerRoot(socketUrl);

  return { apiUrl, socketUrl };
}
