import { createHash, randomBytes } from "node:crypto";

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

import { env } from "../../config/env.js";
import { AppError } from "../../utils/errors.js";

/**
 * Google OpenID Connect — the protocol half.
 *
 * This module knows Google and nothing about ForgeHub: no Prisma, no
 * sessions, no cookies. It builds an authorization URL, exchanges a code, and
 * returns a verified identity. Everything that follows from that identity —
 * who the user is here, whether they may sign in — belongs to
 * `modules/auth/auth.service.ts`, which is where every other login decision
 * already lives.
 *
 * ## Why hand-written rather than a library
 *
 * The three moving parts are an authorization redirect, one `POST`, and an
 * ID-token verification. `jose` is already a dependency (it signs the access
 * tokens) and it is the part that actually warrants a library: JWKS fetching,
 * key rotation, and signature verification are where a hand-rolled
 * implementation goes wrong. The rest is native `fetch` against two
 * documented endpoints. So this adds no package.
 *
 * ## What is deliberately not here
 *
 * No provider token is kept. The exchange returns an access token — and would
 * return a refresh token if this asked for one, which it does not — and both
 * are dropped on the floor once the ID token has been read. ForgeHub calls no
 * Google API after sign-in, so storing a credential for one would be holding
 * a liability with no use (BACKEND_TRD.md §13).
 */

/* ── Google's endpoints ─────────────────────────────────────────────────── */

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";

/**
 * Google issues ID tokens under both spellings and has done for years; a
 * verifier that accepts only one rejects real tokens.
 */
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

/**
 * Identity only. `openid` is what makes this OIDC rather than bare OAuth,
 * `email` and `profile` are the two claims used below. Nothing else is
 * requested, so the consent screen asks for nothing ForgeHub cannot justify.
 */
const SCOPES = ["openid", "email", "profile"];

const TOKEN_REQUEST_TIMEOUT_MS = 10_000;

/* ── Configuration ──────────────────────────────────────────────────────── */

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * Whether the feature is switched on *and* completely configured.
 *
 * Both halves are checked because they are validated together at boot: with
 * `GOOGLE_OAUTH_ENABLED=true` the process refuses to start unless all three
 * values are present, so in a running server the two conditions coincide.
 * Re-checking here is what lets the type below be non-optional.
 */
export function isGoogleOAuthConfigured(): boolean {
  return (
    env.GOOGLE_OAUTH_ENABLED &&
    env.GOOGLE_OAUTH_CLIENT_ID !== undefined &&
    env.GOOGLE_OAUTH_CLIENT_SECRET !== undefined &&
    env.GOOGLE_OAUTH_REDIRECT_URI !== undefined
  );
}

function requireConfig(): GoogleOAuthConfig {
  if (
    !env.GOOGLE_OAUTH_ENABLED ||
    env.GOOGLE_OAUTH_CLIENT_ID === undefined ||
    env.GOOGLE_OAUTH_CLIENT_SECRET === undefined ||
    env.GOOGLE_OAUTH_REDIRECT_URI === undefined
  ) {
    throw AppError.serviceUnavailable("Google sign-in is not configured");
  }

  return {
    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
  };
}

/* ── PKCE ───────────────────────────────────────────────────────────────── */

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/**
 * RFC 7636 S256.
 *
 * A confidential client authenticating with a secret does not strictly need
 * PKCE, but it costs one hash and closes the authorization-code injection
 * case: a code intercepted at the redirect is useless without the verifier,
 * which never leaves this server.
 */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/* ── Authorization request ──────────────────────────────────────────────── */

export interface AuthorizationRequest {
  state: string;
  nonce: string;
  codeChallenge: string;
}

/** The URL to send the browser to. Contains no secret — only the client id. */
export function buildAuthorizationUrl(request: AuthorizationRequest): string {
  const config = requireConfig();
  const url = new URL(AUTHORIZATION_ENDPOINT);

  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    state: request.state,
    nonce: request.nonce,
    code_challenge: request.codeChallenge,
    code_challenge_method: "S256",
    // Ask for an account choice rather than silently reusing whichever Google
    // session the browser happens to hold — signing in as the wrong person is
    // otherwise invisible until the profile page loads.
    prompt: "select_account",
  }).toString();

  return url.toString();
}

/* ── Code exchange ──────────────────────────────────────────────────────── */

interface TokenResponse {
  id_token?: unknown;
}

/**
 * Exchanges the authorization code for an ID token, server to server.
 *
 * Returns *only* the ID token. The response also carries an access token;
 * ignoring it here is what guarantees it can never be stored, logged, or
 * returned — there is no variable holding it after this function returns.
 *
 * The thrown error deliberately carries no part of Google's response body:
 * an exchange failure can echo back the code or the client secret, and this
 * message reaches the logs.
 */
export async function exchangeCodeForIdToken(input: {
  code: string;
  codeVerifier: string;
}): Promise<string> {
  const config = requireConfig();

  const body = new URLSearchParams({
    code: input.code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
    code_verifier: input.codeVerifier,
  });

  let response: Response;
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error("Google token exchange failed before a response was received", {
      cause: error,
    });
  }

  if (!response.ok) {
    throw new Error(`Google rejected the authorization code (${response.status})`);
  }

  let payload: TokenResponse;
  try {
    payload = (await response.json()) as TokenResponse;
  } catch {
    throw new Error("Google token response was not JSON");
  }

  if (typeof payload.id_token !== "string" || payload.id_token.length === 0) {
    throw new Error("Google token response contained no ID token");
  }

  return payload.id_token;
}

/* ── Identity verification ──────────────────────────────────────────────── */

export interface GoogleIdentity {
  /** Google's immutable subject identifier — the linkage key. */
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  pictureUrl: string | null;
}

/**
 * Cached across requests on purpose: the set re-fetches only when it sees a
 * key id it does not hold, which is what makes Google's key rotation
 * invisible here without fetching JWKS on every sign-in.
 */
const jwks = createRemoteJWKSet(new URL(JWKS_URI));

function readString(payload: JWTPayload, claim: string): string | null {
  const value = payload[claim];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Verifies the ID token's signature and every claim that binds it to *this*
 * sign-in.
 *
 * `jwtVerify` checks the signature, `iss`, `aud`, and expiry. The nonce is
 * checked here because only the caller knows which one it minted — and it is
 * what stops a valid ID token captured from another session being replayed
 * into this one.
 */
export async function verifyIdToken(
  idToken: string,
  expectedNonce: string,
): Promise<GoogleIdentity> {
  const config = requireConfig();

  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: ISSUERS,
    audience: config.clientId,
    // Google's clocks and ours are not the same clock.
    clockTolerance: 60,
  });

  const nonce = readString(payload, "nonce");
  if (nonce === null || nonce !== expectedNonce) {
    throw new Error("Google ID token nonce did not match this sign-in");
  }

  const subject = typeof payload.sub === "string" ? payload.sub : null;
  const email = readString(payload, "email");

  if (subject === null || email === null) {
    throw new Error("Google ID token is missing the sub or email claim");
  }

  return {
    subject,
    email: email.toLowerCase(),
    // Strictly `true`, never a truthy string: an absent claim means Google is
    // not attesting the address, which is not the same as attesting it.
    emailVerified: payload["email_verified"] === true,
    name: readString(payload, "name"),
    pictureUrl: readString(payload, "picture"),
  };
}
