import { createHash } from "node:crypto";

import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { ZodError } from "zod";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { safeInternalPath } from "../src/utils/redirect.js";

/**
 * The Google OAuth protocol layer, with Google replaced by a stub.
 *
 * Every test here runs offline. That is not a convenience — a suite that
 * needed the network could not assert the failure cases at all, because the
 * only way to see how this behaves when Google returns a 400, or signs a
 * token with the wrong key, is to be the thing that returns it.
 *
 * What is actually being checked is narrow and worth naming: that the
 * authorization request asks for nothing beyond identity, that PKCE is real
 * rather than decorative, that a token is rejected unless its signature,
 * issuer, audience, and nonce all bind it to *this* sign-in, and that no
 * credential leaves this module by any path — not a return value, not an
 * error message.
 */

const CLIENT_ID = "1234567890-forgehubtest.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-forgehub-test-client-secret";
const REDIRECT_URI = "http://localhost:4000/api/v1/auth/google/callback";

process.env["GOOGLE_OAUTH_ENABLED"] = "true";
process.env["GOOGLE_OAUTH_CLIENT_ID"] = CLIENT_ID;
process.env["GOOGLE_OAUTH_CLIENT_SECRET"] = CLIENT_SECRET;
process.env["GOOGLE_OAUTH_REDIRECT_URI"] = REDIRECT_URI;

const google = await import("../src/integrations/oauth/google.js");
const { parseEnv } = await import("../src/config/env.js");

const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const KID = "forgehub-test-key";

/**
 * The key Google is pretending to sign with, and one it is not.
 *
 * Typed off `generateKeyPair` rather than named directly: jose returns a Web
 * Crypto key here, and this file has no DOM lib to name that type from.
 */
type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

let signingKey: SigningKey;
let impostorKey: SigningKey;
let publicJwk: JWK;

beforeAll(async () => {
  const real = await generateKeyPair("RS256", { extractable: true });
  const fake = await generateKeyPair("RS256", { extractable: true });

  signingKey = real.privateKey;
  impostorKey = fake.privateKey;
  publicJwk = { ...(await exportJWK(real.publicKey)), alg: "RS256", kid: KID };
});

interface IdTokenClaims {
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  picture?: string;
  nonce?: string;
  iss?: string;
  aud?: string;
}

async function signIdToken(
  claims: IdTokenClaims,
  options: { key?: SigningKey; expired?: boolean } = {},
): Promise<string> {
  const { iss = "https://accounts.google.com", aud = CLIENT_ID, ...rest } = claims;

  return new SignJWT({ ...rest })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(options.expired ? "-2h" : "1h")
    .sign(options.key ?? signingKey);
}

/**
 * Stands in for the two Google endpoints this module talks to.
 *
 * Recording every request is the point of the shape: several assertions below
 * are about what was *sent* — that the verifier travelled with the code, that
 * the secret went in a POST body rather than a URL — which is invisible from
 * the return value alone.
 */
interface StubbedCall {
  url: string;
  body: URLSearchParams | null;
}

function stubGoogle(
  tokenResponse: { status?: number; body?: unknown } = {},
): StubbedCall[] {
  const calls: StubbedCall[] = [];

  vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
    const [input, init] = args;
    const url = typeof input === "string" ? input : input.toString();
    const body = typeof init?.body === "string" ? new URLSearchParams(init.body) : null;

    calls.push({ url, body });

    if (url.startsWith(JWKS_URL)) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.startsWith(TOKEN_URL)) {
      const status = tokenResponse.status ?? 200;
      return new Response(
        JSON.stringify(
          tokenResponse.body ?? { id_token: "stub", access_token: "stub-access" },
        ),
        { status, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`Unexpected request to ${url}`);
  });

  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The error a promise rejected with, or a failure if it did not reject. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (caught) {
    if (caught instanceof Error) return caught;
    throw new Error(`Rejected with a non-Error: ${String(caught)}`);
  }
  throw new Error("Expected the promise to reject, but it resolved");
}

/* ── Authorization request ──────────────────────────────────────────────── */

describe("The authorization request", () => {
  const request = {
    state: "state-value",
    nonce: "nonce-value",
    codeChallenge: "challenge-value",
  };

  it("targets Google's authorization endpoint with the configured client", () => {
    const url = new URL(google.buildAuthorizationUrl(request));

    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
  });

  it("uses the authorization-code flow, never the deprecated implicit one", () => {
    const url = new URL(google.buildAuthorizationUrl(request));

    expect(url.searchParams.get("response_type")).toBe("code");
    // `token` or `id_token` here would return credentials in a URL fragment,
    // which is the flow OAuth 2.1 removes.
    expect(url.searchParams.get("response_type")).not.toContain("token");
  });

  it("asks for identity scopes and nothing else", () => {
    const url = new URL(google.buildAuthorizationUrl(request));
    const scopes = (url.searchParams.get("scope") ?? "").split(" ").sort();

    expect(scopes).toEqual(["email", "openid", "profile"]);
  });

  it("requests no Google API scope", () => {
    const scope = new URL(google.buildAuthorizationUrl(request)).searchParams.get(
      "scope",
    );

    for (const api of ["gmail", "drive", "calendar", "contacts", "cloud-platform"]) {
      expect(scope).not.toContain(api);
    }
  });

  it("carries state, nonce, and an S256 PKCE challenge", () => {
    const url = new URL(google.buildAuthorizationUrl(request));

    expect(url.searchParams.get("state")).toBe(request.state);
    expect(url.searchParams.get("nonce")).toBe(request.nonce);
    expect(url.searchParams.get("code_challenge")).toBe(request.codeChallenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("never puts the client secret in the URL", () => {
    // The secret authenticates the *back channel*. Anything in this URL is
    // visible in the address bar, the history, and Google's referrer logs.
    expect(google.buildAuthorizationUrl(request)).not.toContain(CLIENT_SECRET);
  });
});

describe("PKCE", () => {
  it("derives the challenge as the base64url SHA-256 of the verifier", () => {
    const { verifier, challenge } = google.createPkcePair();

    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("produces a fresh, high-entropy verifier every time", () => {
    const verifiers = new Set(
      Array.from({ length: 50 }, () => google.createPkcePair().verifier),
    );

    expect(verifiers.size).toBe(50);
    // 32 random bytes, base64url-encoded — comfortably inside RFC 7636's
    // 43–128 character window.
    for (const verifier of verifiers) {
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(verifier.length).toBeLessThanOrEqual(128);
    }
  });
});

/* ── Code exchange ──────────────────────────────────────────────────────── */

describe("Exchanging the authorization code", () => {
  it("posts the code, the verifier, and the client credentials to Google", async () => {
    const calls = stubGoogle({ body: { id_token: "an-id-token" } });

    const idToken = await google.exchangeCodeForIdToken({
      code: "auth-code",
      codeVerifier: "the-verifier",
    });

    expect(idToken).toBe("an-id-token");

    const call = calls.find((entry) => entry.url.startsWith(TOKEN_URL));
    expect(call).toBeDefined();
    // A back-channel POST: nothing about this request is in a URL.
    expect(call?.url).toBe(TOKEN_URL);
    expect(call?.body?.get("code")).toBe("auth-code");
    expect(call?.body?.get("code_verifier")).toBe("the-verifier");
    expect(call?.body?.get("grant_type")).toBe("authorization_code");
    expect(call?.body?.get("client_secret")).toBe(CLIENT_SECRET);
  });

  it("returns only the ID token, discarding the access token", async () => {
    stubGoogle({
      body: {
        id_token: "an-id-token",
        access_token: "provider-access-token",
        refresh_token: "provider-refresh-token",
      },
    });

    const result = await google.exchangeCodeForIdToken({
      code: "auth-code",
      codeVerifier: "verifier",
    });

    // The signature is `Promise<string>`, so this is the whole surface: there
    // is no field a provider token could be returned in.
    expect(result).toBe("an-id-token");
    expect(result).not.toContain("provider-access-token");
    expect(result).not.toContain("provider-refresh-token");
  });

  it("rejects a non-2xx response without echoing Google's body", async () => {
    stubGoogle({
      status: 400,
      body: { error: "invalid_grant", error_description: "code was already redeemed" },
    });

    const error = await rejection(
      google.exchangeCodeForIdToken({ code: "spent-code", codeVerifier: "verifier" }),
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("400");
    // The message reaches the log. Google's body can quote the request, and
    // the request contains both the code and the client secret.
    expect(error.message).not.toContain("spent-code");
    expect(error.message).not.toContain(CLIENT_SECRET);
    expect(error.message).not.toContain("already redeemed");
  });

  it("rejects a 200 that carries no ID token", async () => {
    stubGoogle({ body: { access_token: "only-an-access-token" } });

    await expect(
      google.exchangeCodeForIdToken({ code: "c", codeVerifier: "v" }),
    ).rejects.toThrow(/no ID token/i);
  });

  it("surfaces a transport failure without the request in the message", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("ECONNREFUSED 142.250.1.1")));

    const error = await rejection(
      google.exchangeCodeForIdToken({ code: "secret-code", codeVerifier: "v" }),
    );

    expect(error.message).toContain("before a response was received");
    expect(error.message).not.toContain("secret-code");
  });
});

/* ── Identity verification ──────────────────────────────────────────────── */

describe("Verifying the ID token", () => {
  const NONCE = "the-expected-nonce";

  async function verify(claims: IdTokenClaims, nonce = NONCE) {
    stubGoogle();
    return google.verifyIdToken(await signIdToken({ nonce: NONCE, ...claims }), nonce);
  }

  it("extracts the identity from a well-formed token", async () => {
    const identity = await verify({
      sub: "108124098124098124098",
      email: "Builder@Example.com",
      email_verified: true,
      name: "Ada Lovelace",
      picture: "https://lh3.googleusercontent.com/a/abc123",
    });

    expect(identity).toEqual({
      subject: "108124098124098124098",
      // Canonicalised, because the email is compared against stored addresses.
      email: "builder@example.com",
      emailVerified: true,
      name: "Ada Lovelace",
      pictureUrl: "https://lh3.googleusercontent.com/a/abc123",
    });
  });

  it("rejects a token signed by anyone but Google", async () => {
    stubGoogle();
    const forged = await signIdToken(
      { sub: "1", email: "a@b.test", email_verified: true, nonce: NONCE },
      { key: impostorKey },
    );

    await expect(google.verifyIdToken(forged, NONCE)).rejects.toThrow();
  });

  it("rejects a token issued for a different client", async () => {
    // An ID token from another Google app is validly signed. Without the
    // audience check, presenting one here would sign you in as its subject.
    await expect(
      verify({ sub: "1", email: "a@b.test", email_verified: true, aud: "someone-else" }),
    ).rejects.toThrow();
  });

  it("rejects a token from the wrong issuer", async () => {
    await expect(
      verify({
        sub: "1",
        email: "a@b.test",
        email_verified: true,
        iss: "https://accounts.evil.example",
      }),
    ).rejects.toThrow();
  });

  it("accepts both spellings of Google's issuer", async () => {
    for (const iss of ["https://accounts.google.com", "accounts.google.com"]) {
      const identity = await verify({
        sub: "1",
        email: "a@b.test",
        email_verified: true,
        iss,
      });
      expect(identity.subject).toBe("1");
    }
  });

  it("rejects an expired token", async () => {
    stubGoogle();
    const stale = await signIdToken(
      { sub: "1", email: "a@b.test", email_verified: true, nonce: NONCE },
      { expired: true },
    );

    await expect(google.verifyIdToken(stale, NONCE)).rejects.toThrow();
  });

  it("rejects a token whose nonce belongs to another sign-in", async () => {
    // The replay guard: a token captured from someone else's flow verifies
    // perfectly on signature, issuer, and audience. The nonce is what ties it
    // to the authorization request this server actually started.
    await expect(
      verify({ sub: "1", email: "a@b.test", email_verified: true }, "a-different-nonce"),
    ).rejects.toThrow(/nonce/i);
  });

  it("rejects a token with no nonce at all", async () => {
    stubGoogle();
    const token = await signIdToken({
      sub: "1",
      email: "a@b.test",
      email_verified: true,
    });

    await expect(google.verifyIdToken(token, NONCE)).rejects.toThrow(/nonce/i);
  });

  it("rejects a token missing the sub or email claim", async () => {
    await expect(verify({ email: "a@b.test", email_verified: true })).rejects.toThrow(
      /sub or email/i,
    );
    await expect(verify({ sub: "1", email_verified: true })).rejects.toThrow(
      /sub or email/i,
    );
  });

  it("treats anything but a boolean true as unverified", async () => {
    // Google sends a JSON boolean. The string "true" would be truthy in a
    // loose check, and an absent claim means Google is declining to attest —
    // which is not the same as attesting.
    for (const value of ["true", undefined] as const) {
      const identity = await verify({
        sub: "1",
        email: "a@b.test",
        ...(value !== undefined ? { email_verified: value } : {}),
      });
      expect(identity.emailVerified).toBe(false);
    }
  });

  it("reports absent optional claims as null rather than empty strings", async () => {
    const identity = await verify({ sub: "1", email: "a@b.test", email_verified: true });

    expect(identity.name).toBeNull();
    expect(identity.pictureUrl).toBeNull();
  });
});

/* ── Open-redirect protection ───────────────────────────────────────────── */

describe("The post-sign-in destination", () => {
  it("keeps ordinary internal paths", () => {
    for (const path of [
      "/dashboard",
      "/projects/forgehub",
      "/profile/ava.codes",
      "/feed?tab=following",
      "/settings/account#security",
    ]) {
      expect(safeInternalPath(path)).toBe(path);
    }
  });

  it("rejects every shape of external destination", () => {
    for (const hostile of [
      "https://evil.example",
      "http://evil.example/phish",
      "//evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "evil.example",
      "https://forgehub.dev.evil.example",
    ]) {
      expect(safeInternalPath(hostile), hostile).toBeNull();
    }
  });

  it("rejects nothing, blanks, control characters, and oversized values", () => {
    expect(safeInternalPath(null)).toBeNull();
    expect(safeInternalPath(undefined)).toBeNull();
    expect(safeInternalPath("")).toBeNull();
    expect(safeInternalPath("   ")).toBeNull();
    // A newline in a Location header is response splitting.
    expect(safeInternalPath("/dashboard\r\nSet-Cookie: a=b")).toBeNull();
    expect(safeInternalPath(`/${"a".repeat(600)}`)).toBeNull();
  });

  it("returns the parsed path rather than echoing the input", () => {
    // Reassembled from `pathname + search + hash`, so nothing that merely
    // looked path-shaped survives in the parts that are kept.
    expect(safeInternalPath("/a/../b")).toBe("/b");
    expect(safeInternalPath("/dashboard?x=1&y=2")).toBe("/dashboard?x=1&y=2");
  });
});

/* ── Configuration ──────────────────────────────────────────────────────── */

describe("Google OAuth configuration", () => {
  const base = {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    REDIS_URL: "redis://localhost:6379",
    JWT_ACCESS_SECRET: "Zm9yZ2VodWItYWNjZXNzLXNlY3JldC1mb3ItdGhlc2UtdGVzdHM",
    JWT_REFRESH_SECRET: "Zm9yZ2VodWItcmVmcmVzaC1zZWNyZXQtZm9yLXRoZXNlLXRlc3Rz",
    TWO_FACTOR_SECRET_KEY: "Zm9yZ2VodWItdHdvLWZhY3Rvci1rZXktZm9yLXRoZXNlLXRlc3Rz",
    EMAIL_PROVIDER: "resend",
    EMAIL_FROM: "ForgeHub <no-reply@example.test>",
    RESEND_API_KEY: "re_a_key_that_is_long_enough",
  } as const;

  const enabled = {
    GOOGLE_OAUTH_ENABLED: "true",
    GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    GOOGLE_OAUTH_REDIRECT_URI: "https://api.example.test/api/v1/auth/google/callback",
  } as const;

  /** The variables a rejection complained about. */
  function refusedFields(source: Record<string, string>): string[] {
    try {
      parseEnv(source as NodeJS.ProcessEnv);
      return [];
    } catch (error) {
      if (error instanceof ZodError) {
        return [...new Set(error.issues.map((issue) => String(issue.path[0])))];
      }
      throw error;
    }
  }

  it("is off by default, and needs no Google credentials to boot", () => {
    const parsed = parseEnv(base as unknown as NodeJS.ProcessEnv);

    expect(parsed.GOOGLE_OAUTH_ENABLED).toBe(false);
    expect(parsed.GOOGLE_OAUTH_CLIENT_ID).toBeUndefined();
  });

  it("boots with the provider fully configured", () => {
    const parsed = parseEnv({ ...base, ...enabled } as unknown as NodeJS.ProcessEnv);

    expect(parsed.GOOGLE_OAUTH_ENABLED).toBe(true);
    expect(parsed.GOOGLE_OAUTH_CLIENT_ID).toBe(CLIENT_ID);
  });

  it("refuses to boot when enabled with a missing value", () => {
    for (const name of [
      "GOOGLE_OAUTH_CLIENT_ID",
      "GOOGLE_OAUTH_CLIENT_SECRET",
      "GOOGLE_OAUTH_REDIRECT_URI",
    ] as const) {
      const source: Record<string, string> = { ...base, ...enabled };
      delete source[name];

      expect(refusedFields(source), `${name} missing`).toContain(name);
    }
  });

  it("reads an empty string as unset, so Compose can forward it unconditionally", () => {
    // Compose substitutes an unset variable as `""`. Without this the mere
    // presence of these lines in docker-compose.yml would fail every boot.
    const parsed = parseEnv({
      ...base,
      GOOGLE_OAUTH_ENABLED: "",
      GOOGLE_OAUTH_CLIENT_ID: "",
      GOOGLE_OAUTH_CLIENT_SECRET: "",
      GOOGLE_OAUTH_REDIRECT_URI: "",
    } as unknown as NodeJS.ProcessEnv);

    expect(parsed.GOOGLE_OAUTH_ENABLED).toBe(false);
    expect(parsed.GOOGLE_OAUTH_CLIENT_SECRET).toBeUndefined();
  });

  it("still refuses blanks when the provider is switched on", () => {
    expect(
      refusedFields({ ...base, ...enabled, GOOGLE_OAUTH_CLIENT_SECRET: "   " }),
    ).toContain("GOOGLE_OAUTH_CLIENT_SECRET");
  });

  it("rejects the .env.example placeholder for the client secret", () => {
    expect(
      refusedFields({
        ...base,
        ...enabled,
        GOOGLE_OAUTH_CLIENT_SECRET: "replace_me_with_your_google_oauth_client_secret",
      }),
    ).toContain("GOOGLE_OAUTH_CLIENT_SECRET");
  });

  it("rejects a client id that is not one — the secret pasted in its place", () => {
    expect(
      refusedFields({ ...base, ...enabled, GOOGLE_OAUTH_CLIENT_ID: CLIENT_SECRET }),
    ).toContain("GOOGLE_OAUTH_CLIENT_ID");
  });

  it("rejects a loopback callback in production", () => {
    // Google would return the authorization code to the visitor's own
    // machine, and the sign-in would fail for everyone but the operator.
    expect(
      refusedFields({
        ...base,
        ...enabled,
        GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:4000/api/v1/auth/google/callback",
      }),
    ).toContain("GOOGLE_OAUTH_REDIRECT_URI");
  });

  it("rejects a plaintext callback on a real host", () => {
    expect(
      refusedFields({
        ...base,
        ...enabled,
        GOOGLE_OAUTH_REDIRECT_URI: "http://api.example.test/api/v1/auth/google/callback",
      }),
    ).toContain("GOOGLE_OAUTH_REDIRECT_URI");
  });

  it("allows the http loopback callback outside production", () => {
    expect(
      refusedFields({
        ...base,
        NODE_ENV: "development",
        EMAIL_PROVIDER: "console",
        EMAIL_FROM: "ForgeHub <no-reply@forgehub.dev>",
        ...enabled,
        GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:4000/api/v1/auth/google/callback",
      }),
    ).toEqual([]);
  });
});
