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
  RESEND_API_KEY: z.preprocess(
    /*
     * Compose (and most container platforms) substitute an unset variable as
     * the empty string rather than omitting it, so `""` has to mean "not
     * configured" — otherwise merely forwarding this key would make every
     * development `docker compose up` fail the length check below.
     *
     * The `.optional()` sits **inside** the preprocess rather than outside
     * it. Outside, it only short-circuits when the value is already
     * `undefined`: an empty string is not, so preprocess would run, hand
     * `undefined` to a required inner schema, and reject with "expected
     * string, received undefined". That is a crash loop on every container
     * that forwards the variable without setting it.
     */
    (value) =>
      typeof value === "string" && value.trim().length === 0 ? undefined : value,
    z
      .string()
      .min(20, "does not look like a Resend API key")
      .refine((value) => !value.toLowerCase().startsWith(PLACEHOLDER_PREFIX), {
        message: "is still the .env.example placeholder — paste the real key from Resend",
      })
      .optional(),
  ),
  /** Public frontend origin — used to build verification/reset links. */
  APP_URL: z.string().url().default("http://localhost:3000"),
  EMAIL_VERIFICATION_EXPIRES: z.string().min(1).default("24h"),
  PASSWORD_RESET_EXPIRES: z.string().min(1).default("1h"),

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
 * All three concern email, and all three exist because the alternative is
 * silence: a misconfigured transport does not fail a request, it drops a
 * password-reset link and returns 200, and nobody finds out until a user
 * cannot get back into their account.
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
  if (value.NODE_ENV === "production" && value.EMAIL_PROVIDER === "console") {
    ctx.addIssue({
      code: "custom",
      path: ["EMAIL_PROVIDER"],
      message:
        "cannot be 'console' in production — it sends nothing. Set EMAIL_PROVIDER=resend and supply RESEND_API_KEY",
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
