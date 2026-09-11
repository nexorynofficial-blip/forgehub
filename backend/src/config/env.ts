import { config as loadDotenv } from "dotenv";
import { z } from "zod";

/**
 * Environment contract. Parsed and validated once at startup — the process
 * refuses to boot on invalid config rather than failing later at the first
 * request that happens to touch a bad value.
 */

loadDotenv();

/**
 * Comma-separated origin list -> string[]. Used for the CORS allowlist.
 * The default is applied to the raw string *before* transforming, so the
 * parsed output type stays `string[]` either way.
 */
const originList = z
  .string()
  .default("http://localhost:3000")
  .transform((value) =>
    value
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  )
  .pipe(z.array(z.string().url()).min(1));

/**
 * `"true"`/`"false"` -> boolean, or `undefined` when unset so the consumer can
 * fall back to an environment-derived default. `z.coerce.boolean()` is not
 * usable here: `Boolean("false")` is `true`.
 */
const optionalBoolean = z
  .union([z.literal("true"), z.literal("false")])
  .optional()
  .transform((value) => (value === undefined ? undefined : value === "true"));

/**
 * The literal prefix used by every placeholder in `.env.example`.
 *
 * A length check alone cannot tell a generated secret from a long
 * placeholder, so `cp .env.example .env && npm run dev` used to boot happily
 * on a signing key and an encryption key that are both published in this
 * repository. Rejecting the placeholder explicitly is what makes the
 * fail-fast machinery actually fire for the case that matters most.
 */
const PLACEHOLDER_PREFIX = "replace_me";

/**
 * The sender `EMAIL_FROM` falls back to.
 *
 * Fine for the console transport, which sends nothing. Named as a constant so
 * the resend rule can reject it by identity: `forgehub.dev` is not a domain
 * any real deployment has verified, so leaving the default in place would
 * mean every message bounced at Resend rather than at boot.
 */
const DEFAULT_EMAIL_FROM = "ForgeHub <no-reply@forgehub.dev>";

/**
 * Reads `""` as "not configured".
 *
 * Compose — and most container platforms — substitute an unset variable as the
 * empty string rather than omitting it, so every optional variable this file
 * forwards has to treat `""` as absent or merely *listing* it in
 * `docker-compose.yml` would fail the value's own validation.
 *
 * The `.optional()` belongs **inside** the preprocess, which is why this is a
 * helper rather than a pattern to re-type. Outside, it only short-circuits a
 * value that is already `undefined`: an empty string is not, so preprocess
 * would run, hand `undefined` to a required inner schema, and reject with
 * "expected string, received undefined" — a crash loop on every container that
 * forwards the variable without setting it.
 */
function optionalUnlessBlank<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) =>
      typeof value === "string" && value.trim().length === 0 ? undefined : value,
    schema.optional(),
  );
}

/** A cryptographic secret: long enough, and demonstrably not the template's. */
function secret(): z.ZodType<string> {
  return z
    .string()
    .min(32, "must be at least 32 characters")
    .refine((value) => !value.toLowerCase().startsWith(PLACEHOLDER_PREFIX), {
      message:
        "is still the .env.example placeholder — generate one with `openssl rand -base64 48`",
    });
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().max(65535).default(4000),
  HOST: z.string().min(1).default("0.0.0.0"),

  /**
   * Where the Next.js frontend runs — drives the CORS allowlist. Named
   * `CORS_ORIGIN` per BACKEND_ARCHITECTURE.md §32; accepts a comma-separated
   * list so multiple deploy previews can be allowed without a schema change.
   */
  CORS_ORIGIN: originList,

  DATABASE_URL: z.string().url().startsWith("postgres"),
  REDIS_URL: z.string().url().startsWith("redis"),

  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  /**
   * 32+ chars keeps HS256 from being brute-forceable, and the placeholder
   * check above means a copied template cannot be mistaken for a real value.
   *
   * `JWT_ACCESS_SECRET` signs access tokens. `JWT_REFRESH_SECRET` does *not*
   * sign anything — refresh tokens are opaque, not JWTs — it is the HMAC key
   * that peppers every stored token hash (`utils/tokens.ts`).
   */
  JWT_ACCESS_SECRET: secret(),
  JWT_REFRESH_SECRET: secret(),
  JWT_ACCESS_EXPIRES: z.string().min(1).default("15m"),
  JWT_REFRESH_EXPIRES: z.string().min(1).default("7d"),
  /** Refresh lifetime when the login form's "Remember me" box is ticked. */
  JWT_REFRESH_REMEMBER_EXPIRES: z.string().min(1).default("30d"),

  /**
   * AES-256-GCM key material for TOTP secrets at rest. Required rather than
   * defaulted: a shipped default encryption key protects nothing — and for
   * the same reason it must not be the `.env.example` placeholder either,
   * which is what `secret()` enforces.
   */
  TWO_FACTOR_SECRET_KEY: secret(),
  TOTP_ISSUER: z.string().min(1).default("ForgeHub"),
  /** How long a half-completed 2FA login stays resumable. */
  TWO_FACTOR_CHALLENGE_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  /* ── Cookies ─────────────────────────────────────────────────────────── */

  REFRESH_COOKIE_NAME: z.string().min(1).default("forgehub_refresh"),
  TWO_FACTOR_COOKIE_NAME: z.string().min(1).default("forgehub_2fa"),
  /**
   * Scoped to the auth routes so the refresh cookie is not attached to every
   * ordinary API call — it is only ever needed by /refresh and /logout.
   */
  AUTH_COOKIE_PATH: z.string().startsWith("/").default("/api/v1/auth"),
  COOKIE_SAMESITE: z.enum(["lax", "strict", "none"]).default("lax"),
  /** Defaults to `true` in production, `false` elsewhere (http://localhost). */
  COOKIE_SECURE: optionalBoolean,
  COOKIE_DOMAIN: z.string().min(1).optional(),

  /* ── Email ───────────────────────────────────────────────────────────── */

  /**
   * Which transport `integrations/email` composes.
   *
   * `console` prints to stdout and refuses to emit in production; `resend`
   * is the production transport. The cross-field rules that make the pair
   * safe — resend requires a key and a real sender, and production refuses
   * console outright — live in the `superRefine` below, because they depend
   * on more than one variable.
   */
  EMAIL_PROVIDER: z.enum(["console", "resend"]).default("console"),

  /**
   * Explicit opt-in to run production on the console transport, which in
   * production delivers nothing: verification and password-reset messages are
   * dropped (the console provider logs that it dropped one, never the token).
   *
   * The rule below still refuses `console` in production by default — an
   * accidental configuration fails the boot, which is the point of it. This
   * flag exists for a deliberate one: a deployment that must run before a mail
   * provider is set up, where the operator accepts that no email is sent.
   * Sign-in, including Google sign-in, never depends on email. The choice
   * is visible as a setting on the host and logged at every boot, so it
   * cannot be forgotten silently. Remove it once RESEND_API_KEY is set.
   */
  EMAIL_CONSOLE_IN_PRODUCTION: z
    .preprocess(
      (value) =>
        typeof value === "string" && value.trim().length === 0 ? undefined : value,
      z.enum(["true", "false"]).default("false"),
    )
    .transform((value) => value === "true"),

  /**
   * The sender address. Resend delivers only from a domain verified in the
   * Resend dashboard, so the shipped default is refused when the resend
   * transport is selected — see `DEFAULT_EMAIL_FROM` below.
   */
  EMAIL_FROM: z.string().min(1).default(DEFAULT_EMAIL_FROM),

  /**
   * Resend API key. Optional here and required by `superRefine` only when
   * `EMAIL_PROVIDER=resend`, so a development checkout needs no mail
   * credential at all.
   *
   * Deliberately not validated with `secret()`: that rule demands 32+
   * characters, and Resend's key length is Resend's to change. The bound
   * below is a sanity floor, and the placeholder check is the part that
   * matters — it is what stops `cp .env.example .env` from booting on a
   * value that is not a key.
   */
  RESEND_API_KEY: optionalUnlessBlank(
    z
      .string()
      .min(20, "does not look like a Resend API key")
      .refine((value) => !value.toLowerCase().startsWith(PLACEHOLDER_PREFIX), {
        message: "is still the .env.example placeholder — paste the real key from Resend",
      }),
  ),
  /** Public frontend origin — used to build verification/reset links. */
  APP_URL: z.string().url().default("http://localhost:3000"),
  EMAIL_VERIFICATION_EXPIRES: z.string().min(1).default("24h"),
  PASSWORD_RESET_EXPIRES: z.string().min(1).default("1h"),

  /* ── Google OAuth ────────────────────────────────────────────────────── */

  /**
   * The master switch for federated sign-in.
   *
   * Explicit rather than inferred from "are the credentials present?", so the
   * feature is never half-on: with this `false` the routes still exist but
   * refuse, and the sign-in button is hidden. With it `true`, every value the
   * flow needs is required by the `superRefine` below and the process will not
   * boot without them.
   */
  GOOGLE_OAUTH_ENABLED: z
    .preprocess(
      (value) =>
        typeof value === "string" && value.trim().length === 0 ? undefined : value,
      z.enum(["true", "false"]).default("false"),
    )
    .transform((value) => value === "true"),

  /**
   * The OAuth client identifier from Google Cloud Console.
   *
   * Not a secret — it is sent to the browser in every authorization redirect —
   * but it is checked for Google's own suffix, because the field beside it in
   * the console is the secret, and pasting them the wrong way round is the
   * mistake this catches at boot rather than at the first sign-in attempt.
   */
  GOOGLE_OAUTH_CLIENT_ID: optionalUnlessBlank(
    z
      .string()
      .endsWith(
        ".apps.googleusercontent.com",
        "must be the Client ID from Google Cloud Console — those always end in .apps.googleusercontent.com",
      ),
  ),

  /** The OAuth client secret. Used only server-to-server, never sent to a browser. */
  GOOGLE_OAUTH_CLIENT_SECRET: optionalUnlessBlank(
    z
      .string()
      .min(16, "does not look like a Google OAuth client secret")
      .refine((value) => !value.toLowerCase().startsWith(PLACEHOLDER_PREFIX), {
        message:
          "is still the .env.example placeholder — paste the real secret from Google Cloud Console",
      }),
  ),

  /**
   * Where Google sends the browser back.
   *
   * Google matches this string **exactly** against the redirect URI registered
   * on the client, so it is configuration rather than something derivable: a
   * deployment behind a proxy may be reached on a host the process cannot see.
   * It must name this API's own callback route — `/api/v1/auth/google/callback`
   * on a default mount.
   */
  GOOGLE_OAUTH_REDIRECT_URI: optionalUnlessBlank(z.string().url()),

  /**
   * Carries the pending authorization across the round trip to Google. A
   * distinct name from the refresh and 2FA cookies because it is a distinct,
   * ten-minute credential scoped to the OAuth routes alone.
   */
  OAUTH_STATE_COOKIE_NAME: z.string().min(1).default("forgehub_oauth_state"),

  /* ── AI ──────────────────────────────────────────────────────────────── */

  /**
   * Which AI provider `integrations/ai` composes (BACKEND_TRD.md §27).
   *
   * TRD §27 lists OpenAI, Anthropic, Google, and local models; only the local
   * one exists so far, so the enum has the two values that can actually be
   * selected today. A hosted provider adds a value here and a `case` in
   * `integrations/ai/index.ts` — nothing else.
   *
   * There is deliberately **no `AI_API_KEY` yet.** TRD §13 lists "AI API
   * keys" among the secrets that must never be committed, and the way to
   * honour that while no provider needs one is to not invent the variable —
   * an unused key in `.env.example` is a placeholder people paste real
   * credentials into. It arrives with the provider that requires it, as a
   * `secret()` like every other credential in this file.
   */
  AI_PROVIDER: z.enum(["local", "disabled"]).default("local"),

  /* ── Rate limiting & brute force ─────────────────────────────────────── */

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),

  /**
   * Tighter budget for the credential endpoints (ARCHITECTURE §28). Distinct
   * from brute-force lockout below: this throttles a *source*, that locks an
   * *account identifier*.
   */
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),

  /** Failures tolerated per identifier before progressive lockout starts. */
  AUTH_BRUTE_FORCE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  AUTH_BRUTE_FORCE_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
  AUTH_BRUTE_FORCE_BASE_LOCK_SECONDS: z.coerce.number().int().positive().default(60),
  AUTH_BRUTE_FORCE_MAX_LOCK_SECONDS: z.coerce.number().int().positive().default(3_600),

  /** Cap on JSON/urlencoded request bodies (defense against payload DoS). */
  BODY_LIMIT: z.string().min(1).default("1mb"),

  /** Wait this long for in-flight requests before forcing exit on SIGTERM. */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
});

/**
 * Rules that span more than one variable, so they cannot live on a field.
 *
 * The email rules exist because the alternative is silence: a misconfigured
 * transport does not fail a request, it drops a password-reset link and
 * returns 200, and nobody finds out until a user cannot get back into their
 * account. The Google OAuth rules exist for the same reason in a different
 * shape — a provider that is switched on but missing a credential would
 * present a working-looking sign-in button that fails at the last step,
 * after the user has already handed their password to Google.
 */
const envSchemaWithRules = envSchema.superRefine((value, ctx) => {
  if (value.EMAIL_PROVIDER === "resend") {
    if (value.RESEND_API_KEY === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["RESEND_API_KEY"],
        message: "is required when EMAIL_PROVIDER=resend",
      });
    }

    if (value.EMAIL_FROM === DEFAULT_EMAIL_FROM) {
      ctx.addIssue({
        code: "custom",
        path: ["EMAIL_FROM"],
        message:
          "must be an address on a domain you have verified with Resend — the built-in default will bounce",
      });
    }
  }

  /**
   * The console transport refuses to print in production (a reset link in
   * container logs is a credential leak), which means selecting it there
   * drops every message. Refusing to boot is the only honest outcome: the
   * previous behaviour was a production deployment that looked healthy and
   * sent no mail at all.
   */
  /**
   * Enabling the provider means committing to all of it. Each of these is
   * unrecoverable at request time: without them the authorization redirect
   * cannot be built, the code cannot be exchanged, or Google will refuse the
   * callback for a redirect_uri it was never told about.
   */
  if (value.GOOGLE_OAUTH_ENABLED) {
    const required = [
      "GOOGLE_OAUTH_CLIENT_ID",
      "GOOGLE_OAUTH_CLIENT_SECRET",
      "GOOGLE_OAUTH_REDIRECT_URI",
    ] as const;

    for (const name of required) {
      if (value[name] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [name],
          message: "is required when GOOGLE_OAUTH_ENABLED=true",
        });
      }
    }

    /**
     * Google refuses a non-HTTPS redirect URI for any host but localhost, and
     * a loopback callback in production would send the user's authorization
     * code to their own machine. Both are caught here rather than by Google's
     * error page halfway through a sign-in.
     */
    if (value.GOOGLE_OAUTH_REDIRECT_URI !== undefined) {
      const redirect = new URL(value.GOOGLE_OAUTH_REDIRECT_URI);
      const isLoopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(
        redirect.hostname,
      );

      if (redirect.protocol !== "https:" && !isLoopback) {
        ctx.addIssue({
          code: "custom",
          path: ["GOOGLE_OAUTH_REDIRECT_URI"],
          message: "must use https — Google only accepts http for localhost",
        });
      }

      if (value.NODE_ENV === "production" && isLoopback) {
        ctx.addIssue({
          code: "custom",
          path: ["GOOGLE_OAUTH_REDIRECT_URI"],
          message:
            "points at this machine, so Google would return the authorization code to the user's own browser rather than to the API. Set it to the public callback URL",
        });
      }
    }
  }

  if (
    value.NODE_ENV === "production" &&
    value.EMAIL_PROVIDER === "console" &&
    !value.EMAIL_CONSOLE_IN_PRODUCTION
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["EMAIL_PROVIDER"],
      message:
        "cannot be 'console' in production — it sends nothing. Set EMAIL_PROVIDER=resend and supply RESEND_API_KEY (or, to run deliberately without email, EMAIL_CONSOLE_IN_PRODUCTION=true)",
    });
  }
});

export type Env = z.infer<typeof envSchemaWithRules>;

/**
 * Exported separately from the module-level parse so tests can exercise
 * validation against arbitrary input without mutating `process.env`.
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchemaWithRules.parse(source);
}

function loadEnv(): Env {
  const result = envSchemaWithRules.safeParse(process.env);

  if (!result.success) {
    // Logger depends on env, so it cannot be used here — plain stderr only.
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    process.stderr.write(`Invalid environment configuration:\n${issues}\n`);
    process.exit(1);
  }

  return result.data;
}

export const env = loadEnv();

export const isProduction = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
export const isDevelopment = env.NODE_ENV === "development";
