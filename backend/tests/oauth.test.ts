import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Google sign-in flow end to end — real PostgreSQL, real Redis, real
 * cookies, real sessions. Google itself is the only thing stubbed.
 *
 * Stubbing Google is what makes the interesting half testable. The cases that
 * matter are the ones a live account cannot produce on demand: an
 * unverified address, a subject that collides with an existing link, a
 * cancelled consent, a replayed state. Each of those is a redirect with a
 * particular error code, and the codes are the contract the frontend renders.
 *
 * The single most important assertion in this file is the negative one — that
 * no token, provider or ForgeHub, ever appears in a redirect URL.
 */

const CLIENT_ID = "1234567890-forgehubtest.apps.googleusercontent.com";
const REDIRECT_URI = "http://localhost:4000/api/v1/auth/google/callback";
const KID = "forgehub-oauth-integration-key";

process.env["GOOGLE_OAUTH_ENABLED"] = "true";
process.env["GOOGLE_OAUTH_CLIENT_ID"] = CLIENT_ID;
process.env["GOOGLE_OAUTH_CLIENT_SECRET"] = "GOCSPX-forgehub-integration-secret";
process.env["GOOGLE_OAUTH_REDIRECT_URI"] = REDIRECT_URI;
process.env["APP_URL"] = "http://localhost:3000";

const { mailbox } = vi.hoisted(() => ({
  mailbox: [] as Array<{ kind: string; to: string; event?: string }>,
}));

vi.mock("../src/integrations/email/index.js", () => ({
  emailService: {
    providerName: "test",
    sendVerificationEmail: (to: string) => {
      mailbox.push({ kind: "verify", to });
      return Promise.resolve();
    },
    sendPasswordResetEmail: (to: string) => {
      mailbox.push({ kind: "reset", to });
      return Promise.resolve();
    },
    sendSecurityAlertEmail: (to: string, o: { event: string }) => {
      mailbox.push({ kind: "alert", to, event: o.event });
      return Promise.resolve();
    },
  },
}));

const { createApp } = await import("../src/app.js");
const { prisma } = await import("../src/database/prisma.js");
const { connectRedis, redis } = await import("../src/config/redis.js");
const { encryptSecret } = await import("../src/utils/crypto.js");
const { generateTotpSecret } = await import("../src/utils/totp.js");

const app = createApp();

const NS = "oauthtest";
const APP_URL = "http://localhost:3000";
const COMPLETION_URL = `${APP_URL}/auth/google/callback`;
const REFRESH_COOKIE = process.env["REFRESH_COOKIE_NAME"] ?? "forgehub_refresh";
const STATE_COOKIE = process.env["OAUTH_STATE_COOKIE_NAME"] ?? "forgehub_oauth_state";
const TWO_FACTOR_COOKIE = process.env["TWO_FACTOR_COOKIE_NAME"] ?? "forgehub_2fa";

let counter = 0;
function uniqueEmail(): string {
  counter += 1;
  return `${NS}.${String(counter)}.${String(Date.now())}@forgehub.test`;
}
function uniqueSubject(): string {
  counter += 1;
  return `google-sub-${String(counter)}-${String(Date.now())}`;
}

/* ── Standing in for Google ─────────────────────────────────────────────── */

/** Typed off `generateKeyPair`: jose hands back a Web Crypto key here. */
type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

let signingKey: SigningKey;
let publicJwk: JWK;

interface StubIdentity {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

/** What the stubbed token endpoint will hand back on the next exchange. */
let pendingIdentity: StubIdentity | null = null;
/** Set to fail the exchange instead, as Google does for a spent code. */
let exchangeStatus = 200;

async function installGoogleStub(): Promise<void> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  signingKey = privateKey;
  publicJwk = { ...(await exportJWK(publicKey)), alg: "RS256", kid: KID };

  vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
    const [input, init] = args;
    const url = typeof input === "string" ? input : input.toString();

    if (url.startsWith("https://www.googleapis.com/oauth2/v3/certs")) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      if (exchangeStatus !== 200) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: exchangeStatus,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (pendingIdentity === null) {
        throw new Error("Token exchange attempted with no identity staged");
      }

      // The nonce comes from the authorization request this server just made,
      // which is the whole point of the claim — so the stub has to read it
      // back out of the URL rather than invent one.
      const body = new URLSearchParams(String(init?.body ?? ""));
      const nonce = nonceForVerifier(body.get("code_verifier") ?? "");

      const idToken = await new SignJWT({
        email_verified: true,
        ...pendingIdentity,
        nonce,
      })
        .setProtectedHeader({ alg: "RS256", kid: KID })
        .setIssuer("https://accounts.google.com")
        .setAudience(CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(signingKey);

      return new Response(
        JSON.stringify({ id_token: idToken, access_token: "provider-access-token" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`Unexpected outbound request to ${url}`);
  });
}

/**
 * The nonce for a pending transaction, looked up by its PKCE verifier.
 *
 * Both live in the same Redis row, and the exchange is the only place the
 * verifier is known — so this is how the stub answers with a token whose
 * nonce the server will actually accept. Reading the row rather than
 * remembering it in a variable also proves the verifier the server sent is
 * the one it stored.
 */
const noncesByVerifier = new Map<string, string>();
function nonceForVerifier(verifier: string): string {
  const nonce = noncesByVerifier.get(verifier);
  if (!nonce) throw new Error("No pending transaction for that code verifier");
  return nonce;
}

/* ── Driving the flow ───────────────────────────────────────────────────── */

interface StartedFlow {
  state: string;
  stateCookie: string;
  authorizationUrl: URL;
}

/** Begins an authorization and captures what the browser would have kept. */
async function startFlow(next?: string): Promise<StartedFlow> {
  const response = await request(app)
    .get("/api/v1/auth/google")
    .query(next !== undefined ? { next } : {})
    .expect(302);

  const authorizationUrl = new URL(response.headers["location"] as string);
  const state = authorizationUrl.searchParams.get("state") ?? "";
  const nonce = authorizationUrl.searchParams.get("nonce") ?? "";

  const setCookie = response.headers["set-cookie"] as unknown as string[];
  const stateCookie = (
    setCookie.find((value) => value.startsWith(`${STATE_COOKIE}=`)) ?? ""
  ).split(";")[0] as string;

  // Read the verifier the server stored, so the stub can answer with a
  // matching nonce when it sees that verifier come back.
  const raw = await redis.get(`oauth:google:${hashState(state)}`);
  if (raw) {
    const transaction = JSON.parse(raw) as { codeVerifier: string };
    noncesByVerifier.set(transaction.codeVerifier, nonce);
  }

  return { state, stateCookie, authorizationUrl };
}

/** The keyed hash the service uses for its Redis key. */
function hashState(state: string): string {
  return hashTokenFn(state);
}
let hashTokenFn: (value: string) => string;

/** Completes the callback the way Google's redirect would. */
async function callback(
  flow: StartedFlow,
  options: { code?: string; state?: string; cookie?: string | null; error?: string } = {},
): Promise<request.Response> {
  const query: Record<string, string> = {};
  if (options.error !== undefined) query["error"] = options.error;
  else query["code"] = options.code ?? "an-authorization-code";
  query["state"] = options.state ?? flow.state;

  const pending = request(app).get("/api/v1/auth/google/callback").query(query);
  const cookie = options.cookie === undefined ? flow.stateCookie : options.cookie;
  if (cookie !== null) pending.set("Cookie", cookie);

  return pending.expect(302);
}

/** One full sign-in as the given Google identity. */
async function signInWithGoogle(
  identity: StubIdentity,
  next?: string,
): Promise<request.Response> {
  pendingIdentity = identity;
  const flow = await startFlow(next);
  return callback(flow);
}

/**
 * The id of a row that must exist.
 *
 * Not just for the types: `where: { userId: undefined }` is not "no rows", it
 * is "no filter", so a lookup that quietly returned null would turn an
 * assertion about one account into an assertion about the whole table.
 */
function idOf(row: { id: string } | null): string {
  if (row === null) throw new Error("Expected the row to exist");
  return row.id;
}

function locationOf(response: request.Response): URL {
  return new URL(response.headers["location"] as string);
}

function cookiesOf(response: request.Response): string[] {
  return (response.headers["set-cookie"] as unknown as string[]) ?? [];
}

function hasCookie(response: request.Response, name: string): boolean {
  return cookiesOf(response).some(
    (value) => value.startsWith(`${name}=`) && !value.startsWith(`${name}=;`),
  );
}

/* ── Lifecycle ──────────────────────────────────────────────────────────── */

beforeAll(async () => {
  await connectRedis();
  await installGoogleStub();
  ({ hashToken: hashTokenFn } = await import("../src/utils/tokens.js"));
});

beforeEach(() => {
  exchangeStatus = 200;
  pendingIdentity = null;
  mailbox.length = 0;
});

afterAll(async () => {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: NS } },
    select: { id: true },
  });
  const ids = users.map((user) => user.id);

  if (ids.length > 0) {
    await prisma.auditLog.deleteMany({
      where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] },
    });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  vi.unstubAllGlobals();
  await prisma.$disconnect();
  await redis.quit();
});

/* ── Starting the flow ──────────────────────────────────────────────────── */

describe("Starting a Google sign-in", () => {
  it("redirects to Google with a state cookie the browser will send back", async () => {
    const flow = await startFlow();

    expect(flow.authorizationUrl.origin).toBe("https://accounts.google.com");
    expect(flow.state.length).toBeGreaterThan(20);
    expect(flow.stateCookie).toContain(`${STATE_COOKIE}=`);
  });

  it("scopes the state cookie tightly and hides it from scripts", async () => {
    const response = await request(app).get("/api/v1/auth/google").expect(302);
    const cookie = cookiesOf(response).find((value) =>
      value.startsWith(`${STATE_COOKIE}=`),
    );

    expect(cookie).toContain("HttpOnly");
    // Narrower than the auth cookie path: this value has no business being
    // attached to /refresh or /logout.
    expect(cookie).toContain("Path=/api/v1/auth/google");
    // Strict would be withheld on Google's cross-site redirect back here.
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=6\d\d(;|$)/);
  });

  it("mints a fresh state and nonce for every attempt", async () => {
    const [first, second] = await Promise.all([startFlow(), startFlow()]);

    expect(first.state).not.toBe(second.state);
    expect(first.authorizationUrl.searchParams.get("nonce")).not.toBe(
      second.authorizationUrl.searchParams.get("nonce"),
    );
    expect(first.authorizationUrl.searchParams.get("code_challenge")).not.toBe(
      second.authorizationUrl.searchParams.get("code_challenge"),
    );
  });

  it("keeps a safe internal destination and discards a hostile one", async () => {
    const kept = await startFlow("/projects/forgehub");
    const keptRow = await redis.get(`oauth:google:${hashState(kept.state)}`);
    expect(JSON.parse(keptRow ?? "{}")).toMatchObject({ next: "/projects/forgehub" });

    const dropped = await startFlow("https://evil.example/steal");
    const droppedRow = await redis.get(`oauth:google:${hashState(dropped.state)}`);
    expect(JSON.parse(droppedRow ?? "{}")).toMatchObject({ next: null });
  });

  it("never sends the PKCE verifier or the client secret to the browser", async () => {
    const response = await request(app).get("/api/v1/auth/google").expect(302);
    const wire = JSON.stringify(response.headers);

    expect(wire).not.toContain(process.env["GOOGLE_OAUTH_CLIENT_SECRET"]);
    expect(wire).not.toContain("code_verifier");
  });
});

/* ── Rejecting a bad callback ───────────────────────────────────────────── */

describe("Rejecting a callback that cannot be trusted", () => {
  it("treats a declined consent as a cancellation, not a failure", async () => {
    const flow = await startFlow();
    const response = await callback(flow, { error: "access_denied" });

    expect(locationOf(response).searchParams.get("error")).toBe("oauth_cancelled");
    expect(hasCookie(response, REFRESH_COOKIE)).toBe(false);
  });

  it("refuses a callback with no state at all", async () => {
    const flow = await startFlow();
    const response = await callback(flow, { state: "" });

    expect(locationOf(response).searchParams.get("error")).toBe("oauth_state_invalid");
  });

  it("refuses a state that does not match the cookie", async () => {
    // The login-CSRF case: an attacker completes their own authorization and
    // sends the victim the resulting URL. Without the cookie binding, the
    // victim's browser would end up inside the attacker's account.
    const attacker = await startFlow();
    const victim = await startFlow();

    const response = await callback(attacker, { cookie: victim.stateCookie });

    expect(locationOf(response).searchParams.get("error")).toBe("oauth_state_invalid");
    expect(hasCookie(response, REFRESH_COOKIE)).toBe(false);
  });

  it("refuses a callback carrying no cookie", async () => {
    const flow = await startFlow();
    const response = await callback(flow, { cookie: null });

    expect(locationOf(response).searchParams.get("error")).toBe("oauth_state_invalid");
  });

  it("spends the state exactly once", async () => {
    pendingIdentity = { sub: uniqueSubject(), email: uniqueEmail() };
    const flow = await startFlow();

    const first = await callback(flow);
    expect(first.headers["location"]).toBe(COMPLETION_URL);

    // Replaying the identical URL — the browser's back button, or a link
    // someone was sent — must not mint a second session.
    const replay = await callback(flow);
    expect(locationOf(replay).searchParams.get("error")).toBe("oauth_state_invalid");
    expect(hasCookie(replay, REFRESH_COOKIE)).toBe(false);
  });

  it("clears the state cookie on every outcome", async () => {
    const flow = await startFlow();
    const response = await callback(flow, { error: "access_denied" });

    const cleared = cookiesOf(response).find((value) =>
      value.startsWith(`${STATE_COOKIE}=`),
    );
    expect(cleared).toBeDefined();
    expect(cleared).toMatch(new RegExp(`^${STATE_COOKIE}=;`));
  });

  it("reports a failed code exchange without leaking Google's answer", async () => {
    exchangeStatus = 400;
    pendingIdentity = { sub: uniqueSubject(), email: uniqueEmail() };
    const flow = await startFlow();

    const response = await callback(flow);
    const location = locationOf(response);

    expect(location.searchParams.get("error")).toBe("oauth_exchange_failed");
    expect(location.toString()).not.toContain("invalid_grant");
  });

  it("refuses an identity whose email Google has not verified", async () => {
    const response = await signInWithGoogle({
      sub: uniqueSubject(),
      email: uniqueEmail(),
      email_verified: false,
    });

    expect(locationOf(response).searchParams.get("error")).toBe("oauth_email_unverified");
    expect(hasCookie(response, REFRESH_COOKIE)).toBe(false);
  });

  it("creates nothing when it refuses", async () => {
    const email = uniqueEmail();
    await signInWithGoogle({ sub: uniqueSubject(), email, email_verified: false });

    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });
});

/* ── First sign-in ──────────────────────────────────────────────────────── */

describe("A Google identity nobody has seen before", () => {
  it("creates an account, links it, and issues an ordinary session", async () => {
    const email = uniqueEmail();
    const sub = uniqueSubject();

    const response = await signInWithGoogle({ sub, email, name: "Grace Hopper" });

    expect(response.headers["location"]).toBe(COMPLETION_URL);
    expect(hasCookie(response, REFRESH_COOKIE)).toBe(true);

    const user = await prisma.user.findUnique({
      where: { email },
      include: { oauthAccounts: true, sessions: true, profile: true },
    });

    expect(user).not.toBeNull();
    expect(user?.displayName).toBe("Grace Hopper");
    expect(user?.oauthAccounts).toHaveLength(1);
    expect(user?.oauthAccounts[0]).toMatchObject({
      provider: "google",
      providerAccountId: sub,
    });
    // The same session table every password login writes to.
    expect(user?.sessions.length).toBeGreaterThan(0);
  });

  it("starts as an ordinary member, never elevated", async () => {
    const email = uniqueEmail();
    await signInWithGoogle({ sub: uniqueSubject(), email });

    const user = await prisma.user.findUnique({ where: { email } });

    expect(user?.role).toBe("member");
    expect(user?.status).toBe("active");
  });

  it("trusts Google's attestation instead of sending its own verification mail", async () => {
    const email = uniqueEmail();
    await signInWithGoogle({ sub: uniqueSubject(), email });

    const user = await prisma.user.findUnique({ where: { email } });

    expect(user?.emailVerified).toBe(true);
    expect(user?.emailVerifiedAt).not.toBeNull();
    expect(mailbox.filter((mail) => mail.kind === "verify")).toEqual([]);
  });

  it("stores no password rather than an unknowable one", async () => {
    const email = uniqueEmail();
    await signInWithGoogle({ sub: uniqueSubject(), email });

    const user = await prisma.user.findUnique({ where: { email } });

    // A random hash here would be a credential nothing can verify and a leak
    // could attack. The column is nullable precisely so this can be null.
    expect(user?.passwordHash).toBeNull();
  });

  it("does not let a password login work against an OAuth-only account", async () => {
    const email = uniqueEmail();
    await signInWithGoogle({ sub: uniqueSubject(), email });

    const response = await request(app)
      .post("/api/v1/auth/login")
      .send({ email, password: "AnythingAtAll123", rememberMe: false })
      .expect(401);

    // The same message a wrong password gets, so this is not an oracle for
    // "which accounts have no password".
    expect(response.body.error.message).toBe("Invalid email or password");
  });

  it("derives a username from the display name, and resolves collisions", async () => {
    const first = uniqueEmail();
    const second = uniqueEmail();

    await signInWithGoogle({ sub: uniqueSubject(), email: first, name: "Ada Byron" });
    await signInWithGoogle({ sub: uniqueSubject(), email: second, name: "Ada Byron" });

    const users = await prisma.user.findMany({
      where: { email: { in: [first, second] } },
      select: { username: true },
    });
    const usernames = users.map((user) => user.username).sort();

    expect(usernames).toHaveLength(2);
    expect(new Set(usernames).size).toBe(2);
    for (const username of usernames) {
      expect(username).toMatch(/^ada\.byron\d*$/);
    }
  });

  it("keeps the Google avatar and falls back to a neutral name", async () => {
    const withPicture = uniqueEmail();
    await signInWithGoogle({
      sub: uniqueSubject(),
      email: withPicture,
      name: "Katherine Johnson",
      picture: "https://lh3.googleusercontent.com/a/xyz",
    });

    const user = await prisma.user.findUnique({
      where: { email: withPicture },
      include: { profile: true },
    });
    expect(user?.profile?.avatarUrl).toBe("https://lh3.googleusercontent.com/a/xyz");

    // No `name` claim: the handle is public, and an email local part is
    // frequently a real name the user did not choose to publish.
    const anonymous = uniqueEmail();
    await signInWithGoogle({ sub: uniqueSubject(), email: anonymous });
    const fallback = await prisma.user.findUnique({ where: { email: anonymous } });

    expect(fallback?.displayName).toBe("New Builder");
    expect(fallback?.username).not.toContain(anonymous.split("@")[0]);
  });

  it("records the sign-up and the link in the audit log", async () => {
    const email = uniqueEmail();
    await signInWithGoogle({ sub: uniqueSubject(), email });

    const user = await prisma.user.findUnique({ where: { email } });
    const actions = await prisma.auditLog.findMany({
      where: { targetId: idOf(user) },
      select: { action: true },
    });

    expect(actions.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(["USER_REGISTERED", "OAUTH_ACCOUNT_LINKED", "USER_LOGIN"]),
    );
  });
});

/* ── Returning ──────────────────────────────────────────────────────────── */

describe("A Google identity that is already linked", () => {
  it("signs into the same account rather than creating a second", async () => {
    const email = uniqueEmail();
    const sub = uniqueSubject();

    await signInWithGoogle({ sub, email });
    const first = await prisma.user.findUnique({ where: { email } });

    await signInWithGoogle({ sub, email });

    expect(await prisma.user.count({ where: { email } })).toBe(1);
    const second = await prisma.user.findUnique({ where: { email } });
    expect(second?.id).toBe(first?.id);
  });

  it("follows the subject, not the address, when Google's email changes", async () => {
    // Google users can change the address on their account. A link that
    // followed the email would follow it to whoever holds it next.
    const original = uniqueEmail();
    const sub = uniqueSubject();

    await signInWithGoogle({ sub, email: original });
    const created = await prisma.user.findUnique({ where: { email: original } });

    const response = await signInWithGoogle({ sub, email: uniqueEmail() });
    expect(response.headers["location"]).toBe(COMPLETION_URL);

    const links = await prisma.oAuthAccount.findMany({
      where: { providerAccountId: sub },
    });
    expect(links).toHaveLength(1);
    expect(links[0]?.userId).toBe(created?.id);
  });

  it("issues a working session the frontend can pick up with /auth/refresh", async () => {
    const response = await signInWithGoogle({
      sub: uniqueSubject(),
      email: uniqueEmail(),
    });

    const refreshCookie = (
      cookiesOf(response).find((value) => value.startsWith(`${REFRESH_COOKIE}=`)) ?? ""
    ).split(";")[0] as string;

    const refreshed = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", refreshCookie)
      .expect(200);

    // The ordinary envelope, the ordinary access token — nothing about this
    // session says it came from a provider.
    expect(refreshed.body.data.accessToken).toEqual(expect.any(String));
    expect(refreshed.body.data.user.email).toEqual(expect.any(String));
  });
});

/* ── Linking to an existing account ─────────────────────────────────────── */

describe("Linking to an account that already exists", () => {
  const PASSWORD = "ValidPass123";

  /** A password account, optionally left with its address unproven. */
  async function registerPasswordUser(options: { verified: boolean }) {
    const email = uniqueEmail();

    await request(app)
      .post("/api/v1/auth/register")
      .send({
        displayName: "Existing Person",
        email,
        password: PASSWORD,
        confirmPassword: PASSWORD,
        agreeToTerms: true,
      })
      .expect(201);

    if (options.verified) {
      await prisma.user.update({
        where: { email },
        data: { emailVerified: true, emailVerifiedAt: new Date() },
      });
    }

    return { email, user: await prisma.user.findUnique({ where: { email } }) };
  }

  it("links when both sides have proven the address", async () => {
    const { email, user } = await registerPasswordUser({ verified: true });
    const sub = uniqueSubject();

    const response = await signInWithGoogle({ sub, email });

    expect(response.headers["location"]).toBe(COMPLETION_URL);
    expect(hasCookie(response, REFRESH_COOKIE)).toBe(true);

    const links = await prisma.oAuthAccount.findMany({ where: { userId: idOf(user) } });
    expect(links).toHaveLength(1);
    expect(links[0]?.providerAccountId).toBe(sub);
    // No second account for the same address.
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });

  it("leaves the password working after linking", async () => {
    const { email } = await registerPasswordUser({ verified: true });
    await signInWithGoogle({ sub: uniqueSubject(), email });

    await request(app)
      .post("/api/v1/auth/login")
      .send({ email, password: PASSWORD, rememberMe: false })
      .expect(200);
  });

  it("tells the owner their account gained a new way in", async () => {
    const { email } = await registerPasswordUser({ verified: true });
    await signInWithGoogle({ sub: uniqueSubject(), email });

    expect(mailbox).toContainEqual(
      expect.objectContaining({
        kind: "alert",
        to: email,
        event: expect.stringContaining("Google"),
      }),
    );
  });

  it("refuses an account that has never proven its address", async () => {
    /*
     * The pre-hijack case. Registration does not prove ownership, so an
     * attacker can register victim@example.com and wait. If a verified Google
     * identity linked into that account anyway, the victim's first Google
     * sign-in would drop them inside the attacker's account — shared, with
     * the attacker's password still working.
     */
    const { email, user } = await registerPasswordUser({ verified: false });

    const response = await signInWithGoogle({ sub: uniqueSubject(), email });

    expect(locationOf(response).searchParams.get("error")).toBe(
      "oauth_account_unverified",
    );
    expect(hasCookie(response, REFRESH_COOKIE)).toBe(false);
    expect(await prisma.oAuthAccount.count({ where: { userId: idOf(user) } })).toBe(0);
  });

  it("refuses a second Google identity for an already-linked account", async () => {
    const { email, user } = await registerPasswordUser({ verified: true });
    await signInWithGoogle({ sub: uniqueSubject(), email });

    // Same address, different Google subject — two people, or one person with
    // two Google accounts. Relinking silently would be a takeover.
    const response = await signInWithGoogle({ sub: uniqueSubject(), email });

    expect(locationOf(response).searchParams.get("error")).toBe("oauth_account_conflict");
    expect(await prisma.oAuthAccount.count({ where: { userId: idOf(user) } })).toBe(1);
  });

  it("records the rejection so a run of them is visible", async () => {
    const { email, user } = await registerPasswordUser({ verified: false });
    await signInWithGoogle({ sub: uniqueSubject(), email });

    const rejected = await prisma.auditLog.findFirst({
      where: { targetId: idOf(user), action: "OAUTH_LINK_REJECTED" },
    });

    expect(rejected).not.toBeNull();
  });
});

/* ── Enforcement ────────────────────────────────────────────────────────── */

describe("Google sign-in does not bypass account enforcement", () => {
  it("refuses a banned account that is already linked", async () => {
    const email = uniqueEmail();
    const sub = uniqueSubject();

    await signInWithGoogle({ sub, email });
    await prisma.user.update({ where: { email }, data: { status: "banned" } });

    const response = await signInWithGoogle({ sub, email });

    expect(locationOf(response).searchParams.get("error")).toBe(
      "oauth_account_suspended",
    );
    expect(hasCookie(response, REFRESH_COOKIE)).toBe(false);
  });

  it("refuses a banned account at the linking step, and does not link it", async () => {
    const email = uniqueEmail();
    await prisma.user.create({
      data: {
        email,
        username: `${NS}banned${String(Date.now())}`.slice(0, 30),
        displayName: "Banned Person",
        emailVerified: true,
        status: "banned",
        profile: { create: {} },
      },
    });

    const response = await signInWithGoogle({ sub: uniqueSubject(), email });

    expect(locationOf(response).searchParams.get("error")).toBe(
      "oauth_account_suspended",
    );
    const user = await prisma.user.findUnique({ where: { email } });
    expect(await prisma.oAuthAccount.count({ where: { userId: idOf(user) } })).toBe(0);
  });

  it("stops at the two-factor challenge instead of substituting for it", async () => {
    /*
     * ForgeHub's policy is that an enrolled second factor is required to sign
     * in, with no exemption for a login method. Treating Google as the second
     * factor would downgrade every account that turned 2FA on, without
     * telling the person who turned it on.
     */
    const email = uniqueEmail();
    const sub = uniqueSubject();
    await signInWithGoogle({ sub, email });

    const user = await prisma.user.findUnique({ where: { email } });
    await prisma.twoFactorCredential.create({
      data: {
        userId: idOf(user),
        secret: encryptSecret(generateTotpSecret()),
        enabled: true,
        backupCodes: [],
      },
    });

    const response = await signInWithGoogle({ sub, email });

    expect(response.headers["location"]).toBe(`${APP_URL}/2fa`);
    // No session yet — the challenge cookie is not a credential for anything
    // but /auth/2fa/challenge.
    expect(hasCookie(response, REFRESH_COOKIE)).toBe(false);
    expect(hasCookie(response, TWO_FACTOR_COOKIE)).toBe(true);
  });
});

/* ── What crosses the wire ──────────────────────────────────────────────── */

describe("Nothing sensitive reaches the browser", () => {
  it("puts no token of any kind in the redirect URL", async () => {
    const response = await signInWithGoogle({
      sub: uniqueSubject(),
      email: uniqueEmail(),
    });
    const location = response.headers["location"] as string;

    expect(location).toBe(COMPLETION_URL);
    for (const forbidden of [
      "provider-access-token",
      "access_token",
      "id_token",
      "refresh",
      "token",
      "eyJ",
    ]) {
      expect(location, forbidden).not.toContain(forbidden);
    }
  });

  it("stores no provider token anywhere", async () => {
    const email = uniqueEmail();
    await signInWithGoogle({ sub: uniqueSubject(), email });

    const user = await prisma.user.findUnique({
      where: { email },
      include: { oauthAccounts: true },
    });

    // The row has columns for an id, a provider, a subject, and timestamps.
    // There is nowhere for a credential to be, which is the point.
    expect(Object.keys(user?.oauthAccounts[0] ?? {}).sort()).toEqual([
      "createdAt",
      "id",
      "provider",
      "providerAccountId",
      "updatedAt",
      "userId",
    ]);
  });

  it("carries a safe destination through and refuses a hostile one", async () => {
    pendingIdentity = { sub: uniqueSubject(), email: uniqueEmail() };
    const safe = await startFlow("/projects/forgehub");
    const kept = await callback(safe);

    expect(locationOf(kept).searchParams.get("next")).toBe("/projects/forgehub");

    pendingIdentity = { sub: uniqueSubject(), email: uniqueEmail() };
    const hostile = await startFlow("https://evil.example");
    const dropped = await callback(hostile);

    expect(locationOf(dropped).searchParams.get("next")).toBeNull();
    expect(dropped.headers["location"]).toBe(COMPLETION_URL);
  });

  it("only ever redirects to the configured frontend origin", async () => {
    const outcomes = await Promise.all([
      signInWithGoogle({ sub: uniqueSubject(), email: uniqueEmail() }),
      signInWithGoogle({
        sub: uniqueSubject(),
        email: uniqueEmail(),
        email_verified: false,
      }),
    ]);

    for (const response of outcomes) {
      expect(locationOf(response).origin).toBe(APP_URL);
    }
  });
});
