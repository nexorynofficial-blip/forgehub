import { afterEach, describe, expect, it, vi } from "vitest";

import { parseEnv } from "../src/config/env.js";
import { ConsoleEmailProvider } from "../src/integrations/email/console.provider.js";
import { EmailService } from "../src/integrations/email/email.service.js";
import type {
  EmailMessage,
  EmailProvider,
} from "../src/integrations/email/email.types.js";
import { ResendEmailProvider } from "../src/integrations/email/resend.provider.js";
import { logger } from "../src/utils/logger.js";

/**
 * Transactional email (BACKEND_TRD.md §26).
 *
 * Two things are pinned here, and both exist because a mail fault is silent
 * by design — `EmailService` swallows transport failures so a mail outage
 * cannot fail a registration that already committed, and so the caller cannot
 * learn whether an address exists. That is correct, and it is exactly why the
 * configuration has to be provably right before a message is ever sent:
 *
 *   1. **The transport does what the API expects.** The Resend provider is
 *      exercised against a stubbed `fetch`, which is the real boundary — the
 *      provider uses no SDK, so this is the same code path production runs.
 *   2. **A misconfiguration fails at boot, not at 3am.** The cross-field env
 *      rules are what stop a production deployment from looking healthy while
 *      dropping every password-reset link.
 */

const API_KEY = "re_test_key_that_is_not_a_real_credential";
const FROM = "ForgeHub <no-reply@mail.example.test>";
const ENDPOINT = "https://api.resend.test/emails";

function provider(overrides: Partial<Parameters<typeof buildOptions>[0]> = {}) {
  return new ResendEmailProvider(buildOptions(overrides));
}

function buildOptions(
  overrides: {
    apiKey?: string;
    from?: string;
    endpoint?: string;
    timeoutMs?: number;
  } = {},
) {
  return {
    apiKey: overrides.apiKey ?? API_KEY,
    from: overrides.from ?? FROM,
    endpoint: overrides.endpoint ?? ENDPOINT,
    ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
  };
}

const MESSAGE: EmailMessage = {
  to: "builder@example.test",
  subject: "Reset your ForgeHub password",
  text: "https://app.example.test/reset-password?token=single-use-token",
};

/** A stubbed `fetch` recording what the provider actually sent. */
function stubFetch(response: Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fake = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(response);
  });
  vi.stubGlobal("fetch", fake);
  return calls;
}

/**
 * The one recorded call, narrowed. `noUncheckedIndexedAccess` makes every
 * array index `T | undefined`, and asserting once here beats a non-null
 * assertion at each of the eight call sites below.
 */
function only(calls: Array<{ url: string; init: RequestInit }>) {
  expect(calls).toHaveLength(1);
  const call = calls[0];
  if (!call) throw new Error("unreachable — length was just asserted");
  return call;
}

/** The body the provider actually posted, parsed. */
function sentBody(calls: Array<{ url: string; init: RequestInit }>) {
  return JSON.parse(only(calls).init.body as string) as Record<string, unknown>;
}

/** Awaits a rejection and hands back the `Error`, typed as one. */
async function rejection(promise: Promise<void>): Promise<Error> {
  try {
    await promise;
  } catch (caught) {
    return caught as Error;
  }
  throw new Error("expected the send to reject, but it resolved");
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ResendEmailProvider", () => {
  it("identifies itself as the resend transport", () => {
    expect(provider().name).toBe("resend");
  });

  it("POSTs the message to Resend with a bearer key and JSON body", async () => {
    const calls = stubFetch(json(200, { id: "msg_123" }));

    await provider().send(MESSAGE);

    const call = only(calls);
    expect(call.url).toBe(ENDPOINT);
    expect(call.init.method).toBe("POST");

    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(headers["Content-Type"]).toBe("application/json");

    const body = sentBody(calls);
    expect(body.from).toBe(FROM);
    // The array form is what the API documents; a bare string also works, but
    // only one of the two is unambiguous.
    expect(body.to).toEqual([MESSAGE.to]);
    expect(body.subject).toBe(MESSAGE.subject);
    expect(body.text).toBe(MESSAGE.text);
  });

  it("omits `html` entirely rather than sending null", async () => {
    const calls = stubFetch(json(200, { id: "msg_123" }));

    await provider().send(MESSAGE);

    expect("html" in sentBody(calls)).toBe(false);
  });

  it("includes `html` when the caller supplies one", async () => {
    const calls = stubFetch(json(200, { id: "msg_123" }));

    await provider().send({ ...MESSAGE, html: "<p>hi</p>" });

    expect(sentBody(calls).html).toBe("<p>hi</p>");
  });

  it("throws on a rejection, surfacing Resend's own reason", async () => {
    stubFetch(
      json(403, { name: "validation_error", message: "The domain is not verified" }),
    );

    await expect(provider().send(MESSAGE)).rejects.toThrow(
      /403.*validation_error.*domain is not verified/s,
    );
  });

  it("never puts the message body or recipient into the thrown error", async () => {
    // The body of a reset mail is a single-use token. An error that echoed it
    // would put that token wherever the error is reported.
    stubFetch(json(422, { name: "invalid_parameter", message: "from is invalid" }));

    const error = await rejection(provider().send(MESSAGE));

    const serialized = `${error.message} ${String(error.stack)}`;
    expect(serialized).not.toContain("single-use-token");
    expect(serialized).not.toContain(MESSAGE.to);
  });

  it("degrades to the status text when the error body is not JSON", async () => {
    // A 502 from a proxy in front of the API is HTML, not an error envelope.
    stubFetch(new Response("<html>Bad Gateway</html>", { status: 502 }));

    await expect(provider().send(MESSAGE)).rejects.toThrow(/502/);
  });

  it("wraps a network fault rather than leaking the raw failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))),
    );

    const error = await rejection(provider().send(MESSAGE));

    expect(error.message).toContain("Resend request failed");
    // The original is kept for the log, not discarded.
    expect((error.cause as Error).message).toBe("ECONNREFUSED");
  });

  it("performs no I/O of its own beyond the single POST", async () => {
    const calls = stubFetch(json(200, { id: "msg_123" }));

    await provider().send(MESSAGE);
    await provider().send({ ...MESSAGE, to: "other@example.test" });

    expect(calls).toHaveLength(2);
  });
});

describe("EmailService over the Resend transport", () => {
  it("builds verification links from APP_URL and the frontend route", async () => {
    const calls = stubFetch(json(200, { id: "msg_123" }));
    const service = new EmailService(provider());

    await service.sendVerificationEmail("builder@example.test", {
      displayName: "Ada",
      token: "verification-token-value",
    });

    // The path must match the shipped frontend route, or the link 404s.
    expect(sentBody(calls).text).toContain(
      "/verify-email?token=verification-token-value",
    );
  });

  it("builds reset links against the /reset-password route", async () => {
    const calls = stubFetch(json(200, { id: "msg_123" }));
    const service = new EmailService(provider());

    await service.sendPasswordResetEmail("builder@example.test", {
      displayName: "Ada",
      token: "reset-token-value",
    });

    expect(sentBody(calls).text).toContain("/reset-password?token=reset-token-value");
  });

  it("sends the security alert through the same transport", async () => {
    const calls = stubFetch(json(200, { id: "msg_123" }));
    const service = new EmailService(provider());

    await service.sendSecurityAlertEmail("builder@example.test", {
      displayName: "Ada",
      event: "your password was reset",
    });

    expect(sentBody(calls).subject).toBe("ForgeHub security alert");
  });

  it("swallows a transport failure so a committed registration cannot fail", async () => {
    stubFetch(json(500, { name: "internal_error", message: "upstream" }));
    const service = new EmailService(provider());

    await expect(
      service.sendVerificationEmail("builder@example.test", {
        displayName: "Ada",
        token: "verification-token-value",
      }),
    ).resolves.toBeUndefined();
  });

  it("logs a failure without the recipient or the token", async () => {
    stubFetch(json(500, { name: "internal_error", message: "upstream" }));
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const service = new EmailService(provider());

    await service.sendPasswordResetEmail("builder@example.test", {
      displayName: "Ada",
      token: "reset-token-value",
    });

    expect(error).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(error.mock.calls[0]);
    expect(logged).not.toContain("reset-token-value");
    expect(logged).not.toContain("builder@example.test");
    // What it does record: which transport, and what kind of message.
    expect(logged).toContain("resend");
  });
});

describe("The email composition root's contract", () => {
  it("accepts any provider through the same interface", () => {
    // The property TRD §26 asks for: callers depend on `EmailProvider`, never
    // on a transport. Both shipped providers satisfy it identically.
    const providers: EmailProvider[] = [new ConsoleEmailProvider(), provider()];

    for (const candidate of providers) {
      expect(typeof candidate.name).toBe("string");
      expect(typeof candidate.send).toBe("function");
      expect(new EmailService(candidate).providerName).toBe(candidate.name);
    }
  });
});

describe("Email environment validation", () => {
  const REQUIRED = {
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    REDIS_URL: "redis://localhost:6379",
    JWT_ACCESS_SECRET: "ZW1haWwtYWNjZXNzLXNlY3JldC1mb3ItdGVzdHMtb25seQ",
    JWT_REFRESH_SECRET: "ZW1haWwtcmVmcmVzaC1zZWNyZXQtZm9yLXRlc3RzLW9ubHk",
    TWO_FACTOR_SECRET_KEY: "ZW1haWwtdHdvLWZhY3Rvci1rZXktZm9yLXRlc3RzLW9ubHk",
  };

  const RESEND = {
    ...REQUIRED,
    EMAIL_PROVIDER: "resend",
    RESEND_API_KEY: API_KEY,
    EMAIL_FROM: FROM,
  };

  it("defaults to console so a fresh checkout needs no mail credential", () => {
    const parsed = parseEnv({ ...REQUIRED });
    expect(parsed.EMAIL_PROVIDER).toBe("console");
    expect(parsed.RESEND_API_KEY).toBeUndefined();
  });

  it("accepts a fully configured resend transport", () => {
    const parsed = parseEnv({ ...RESEND });
    expect(parsed.EMAIL_PROVIDER).toBe("resend");
    expect(parsed.RESEND_API_KEY).toBe(API_KEY);
    expect(parsed.EMAIL_FROM).toBe(FROM);
  });

  it("reads an empty API key as absent, not as a bad one", () => {
    /*
     * Compose forwards `RESEND_API_KEY: ${RESEND_API_KEY}`, and an unset
     * variable substitutes as "" rather than being omitted. Every container
     * that forwards the key without setting it lands here.
     *
     * This is a regression test: the first implementation put `.optional()`
     * outside the preprocess, where it only short-circuits a value that is
     * already `undefined`. An empty string is not, so preprocess ran, handed
     * `undefined` to a required inner schema, and the backend crash-looped on
     * "expected string, received undefined" — caught by a container boot, not
     * by this suite, because nothing here had ever passed "".
     */
    for (const empty of ["", "   "]) {
      const parsed = parseEnv({ ...REQUIRED, RESEND_API_KEY: empty });
      expect(parsed.RESEND_API_KEY).toBeUndefined();
      expect(parsed.EMAIL_PROVIDER).toBe("console");
    }
  });

  it("still refuses resend when the forwarded key is empty", () => {
    // The empty string means "not configured", so selecting resend with one
    // has to fail exactly as an absent key does.
    expect(() => parseEnv({ ...RESEND, RESEND_API_KEY: "" })).toThrow(/RESEND_API_KEY/);
  });

  it("refuses resend without an API key", () => {
    // Booting here would mean a deployment that reports healthy and silently
    // drops every verification and reset mail.
    expect(() => parseEnv({ ...RESEND, RESEND_API_KEY: undefined })).toThrow(
      /RESEND_API_KEY/,
    );
  });

  it("refuses the .env.example placeholder as an API key", () => {
    expect(() =>
      parseEnv({ ...RESEND, RESEND_API_KEY: "replace_me_with_your_resend_api_key" }),
    ).toThrow();
  });

  it("refuses an API key too short to be one", () => {
    expect(() => parseEnv({ ...RESEND, RESEND_API_KEY: "re_short" })).toThrow();
  });

  it("refuses the built-in sender when resend is selected", () => {
    // Resend delivers only from a verified domain, and `forgehub.dev` is not
    // one any deployment owns — leaving the default would bounce every
    // message at the API instead of failing here.
    const { EMAIL_FROM: _omitted, ...withoutFrom } = RESEND;
    expect(() => parseEnv(withoutFrom)).toThrow(/EMAIL_FROM/);
  });

  it("refuses the console transport in production", () => {
    // The console provider refuses to print in production, so selecting it
    // there sends nothing at all. That must be a boot failure, not a silent
    // one — this is the exact configuration that made production email a
    // launch blocker.
    expect(() => parseEnv({ ...REQUIRED, NODE_ENV: "production" })).toThrow(
      /EMAIL_PROVIDER/,
    );
  });

  it("accepts the console transport in production only with the explicit opt-in", () => {
    const parsed = parseEnv({
      ...REQUIRED,
      NODE_ENV: "production",
      EMAIL_CONSOLE_IN_PRODUCTION: "true",
    });
    expect(parsed.EMAIL_PROVIDER).toBe("console");
    expect(parsed.EMAIL_CONSOLE_IN_PRODUCTION).toBe(true);
  });

  it("keeps refusing console in production unless the opt-in is exactly true", () => {
    // Anything short of an explicit "true" leaves the default refusal in
    // place — the flag cannot be half-set into disabling the guard.
    for (const optIn of ["false", "", "   "]) {
      expect(() =>
        parseEnv({
          ...REQUIRED,
          NODE_ENV: "production",
          EMAIL_CONSOLE_IN_PRODUCTION: optIn,
        }),
      ).toThrow(/EMAIL_PROVIDER/);
    }
    expect(() =>
      parseEnv({
        ...REQUIRED,
        NODE_ENV: "production",
        EMAIL_CONSOLE_IN_PRODUCTION: "yes",
      }),
    ).toThrow();
  });

  it("accepts a configured resend transport in production", () => {
    expect(parseEnv({ ...RESEND, NODE_ENV: "production" }).EMAIL_PROVIDER).toBe("resend");
  });

  it("still allows the console transport outside production", () => {
    for (const nodeEnv of ["development", "test"] as const) {
      expect(parseEnv({ ...REQUIRED, NODE_ENV: nodeEnv }).EMAIL_PROVIDER).toBe("console");
    }
  });

  it("refuses a provider that has no implementation", () => {
    expect(() => parseEnv({ ...REQUIRED, EMAIL_PROVIDER: "sendgrid" })).toThrow();
  });
});
