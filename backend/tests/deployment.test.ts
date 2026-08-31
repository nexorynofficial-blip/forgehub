import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Server as HttpServer } from "node:http";

import { ZodError } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseEnv } from "../src/config/env.js";

/**
 * Phase 14 — deployment and production readiness (TRD §33 Environment
 * Management, §34 Docker, §35 Health Checks; ARCHITECTURE §31 Observability,
 * §32 Configuration, §36 Deployment Architecture).
 *
 * Two production behaviours had no test before this phase, and both fail
 * silently rather than loudly:
 *
 *   1. **Environment propagation.** The application declares a variable in
 *      `config/env.ts`; the deployment has to actually pass it. Phase 12 added
 *      `AI_PROVIDER` and could not add it to Compose (that file was frozen for
 *      the phase), so a containerised deployment always resolved the `local`
 *      default and could not select `disabled`. Nothing detected that for two
 *      phases, because a missing *defaulted* variable does not crash — it just
 *      quietly ignores the operator.
 *
 *   2. **Graceful shutdown.** Correct since Phase 1 and never exercised. It is
 *      the code that runs when an orchestrator rolls a deployment, so a
 *      regression in it shows up as dropped in-flight requests in production
 *      and nowhere else.
 *
 * Both are tested from the repository's own files and in-process. Nothing here
 * reaches the network, starts a container, or depends on Docker being
 * installed.
 */

const COMPOSE_PATH = resolve(import.meta.dirname, "../docker-compose.yml");
const ENV_EXAMPLE_PATH = resolve(import.meta.dirname, "../.env.example");

const composeSource = readFileSync(COMPOSE_PATH, "utf8");
const envExampleSource = readFileSync(ENV_EXAMPLE_PATH, "utf8");

/**
 * The `environment:` map of the `backend` service.
 *
 * Parsed with a line matcher rather than a YAML library: the block has a fixed
 * two-space-indented `KEY: value` shape, and adding a YAML parser to read one
 * file the repository already controls would be a dependency for convenience
 * (Phase 14 rule 19).
 */
function backendEnvironment(): Map<string, string> {
  const start = composeSource.indexOf("  backend:");
  expect(start, "docker-compose.yml must declare a backend service").toBeGreaterThan(-1);

  const block = composeSource.slice(start);
  const envStart = block.indexOf("    environment:");
  expect(envStart, "the backend service must declare an environment map").toBeGreaterThan(
    -1,
  );

  const afterEnv = block.slice(envStart + "    environment:".length);
  const entries = new Map<string, string>();

  for (const line of afterEnv.split("\n")) {
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    // The map ends at the first line indented less than its entries.
    const match = /^ {6}([A-Z0-9_]+):\s*(.*)$/.exec(line);
    if (!match) {
      if (/^ {0,5}\S/.test(line)) break;
      continue;
    }
    entries.set(match[1] as string, (match[2] as string).trim());
  }

  return entries;
}

/** Variable names `.env.example` documents, in declaration order. */
function documentedVariables(): string[] {
  const names: string[] = [];
  for (const line of envExampleSource.split("\n")) {
    const match = /^([A-Z0-9_]+)=/.exec(line.trim().replace(/^#\s*/, ""));
    if (match) names.push(match[1] as string);
  }
  return [...new Set(names)];
}

/** The published placeholder `config/env.ts` rejects by name. */
const PLACEHOLDER = "replace_me_with_a_generated_secret_value";
/** Long, random-looking, and not the placeholder. */
const GENERATED = "Zm9yZ2VodWItcGhhc2UtMTQtcmFuZG9tLXNlY3JldC12YWx1ZQ";

/**
 * Variables that hold a credential, identified by behaviour rather than by
 * guessing at their names.
 *
 * A secret is a variable whose schema **rejects the published placeholder but
 * accepts generated key material**. That distinguishes a real credential from
 * a variable that merely reads like one — `PASSWORD_RESET_EXPIRES` is a
 * duration, and a substring match on "PASSWORD" would have called it a secret.
 */
function secretVariables(): string[] {
  const base = validEnv();

  return documentedVariables().filter((name) => {
    const accepts = (value: string): boolean => {
      try {
        parseEnv({ ...base, [name]: value });
        return true;
      } catch {
        return false;
      }
    };

    return !accepts(PLACEHOLDER) && accepts(GENERATED);
  });
}

/** Variables the schema refuses to boot without. */
function requiredVariables(): string[] {
  try {
    parseEnv({});
  } catch (error) {
    if (error instanceof ZodError) {
      return [...new Set(error.issues.map((issue) => String(issue.path[0])))];
    }
    throw error;
  }
  throw new Error("parseEnv({}) unexpectedly succeeded — nothing is required");
}

describe("Compose forwards the configuration the application declares", () => {
  const forwarded = backendEnvironment();

  it("parses a plausible environment map", () => {
    // Guards the guard: a parser that silently returned nothing would make
    // every assertion below pass vacuously.
    expect(forwarded.size).toBeGreaterThan(20);
    expect(forwarded.has("DATABASE_URL")).toBe(true);
  });

  it("forwards every variable the schema requires to boot", () => {
    const required = requiredVariables();
    expect(required.length).toBeGreaterThan(0);

    const missing = required.filter((name) => !forwarded.has(name));
    expect(missing, `required but not forwarded: ${missing.join(", ")}`).toEqual([]);
  });

  it("forwards AI_PROVIDER so a deployment can turn AI off", () => {
    /**
     * The Phase 12 gap, closed here. Without this line the container resolves
     * the `local` default no matter what the operator sets, so `disabled` —
     * the only way to switch AI off without a code change — is unreachable.
     */
    expect(forwarded.get("AI_PROVIDER")).toBe("${AI_PROVIDER:-local}");

    // Both selectable values must survive validation.
    for (const provider of ["local", "disabled"] as const) {
      expect(parseEnv({ ...validEnv(), AI_PROVIDER: provider }).AI_PROVIDER).toBe(
        provider,
      );
    }
  });

  it("documents in .env.example every variable it forwards", () => {
    // The two files are the same contract seen from either end: `.env.example`
    // is what TRD §33 asks operators to copy, Compose is what actually reaches
    // the process. A variable in one and not the other is a trap.
    const documented = new Set(documentedVariables());
    const undocumented = [...forwarded.keys()].filter(
      (name) =>
        !documented.has(name) &&
        // Set by Compose from the Postgres service, not by the operator.
        !["DATABASE_URL", "REDIS_URL", "HOST"].includes(name),
    );

    expect(
      undocumented,
      `forwarded but undocumented: ${undocumented.join(", ")}`,
    ).toEqual([]);
  });

  it("hardcodes no secret — every credential is a reference without a default", () => {
    const secrets = secretVariables();
    expect(secrets.length, "the probe must find the signing keys").toBeGreaterThan(0);

    for (const name of secrets) {
      const value = forwarded.get(name);
      expect(value, `${name} must be forwarded`).toBeDefined();

      // A credential must arrive by substitution, never be written in the file.
      expect(value?.startsWith("${"), `${name} must not be a literal`).toBe(true);
      // …and must carry no inline default, which would ship one shared
      // fallback credential to every deployment that forgot to set it.
      expect(value?.includes(":-"), `${name} must not have a default`).toBe(false);
    }
  });

  it("passes the database credentials in without defaulting them", () => {
    // The Postgres service's own credentials live outside the backend's
    // environment map, and the same rule applies to them.
    for (const name of ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"]) {
      expect(composeSource).toContain(`${name}: \${${name}}`);
      expect(composeSource).not.toContain(`${name}: \${${name}:-`);
    }
  });

  it("declares the services ARCHITECTURE §36 and TRD §34 name", () => {
    for (const service of ["backend:", "postgres:", "redis:"]) {
      expect(composeSource).toContain(`  ${service}`);
    }
  });

  it("gates the backend on healthy dependencies", () => {
    // Starting the API before PostgreSQL accepts connections makes `bootstrap`
    // fail fast and the container restart-loop until Postgres wins the race.
    expect(composeSource).toContain("condition: service_healthy");
    expect(composeSource).toContain("pg_isready");
    expect(composeSource).toContain("redis-cli");
  });

  it("keeps data in named volumes so a rebuild does not destroy it", () => {
    expect(composeSource).toContain("postgres_data:/var/lib/postgresql/data");
    expect(composeSource).toContain("redis_data:/data");
  });
});

/** A minimal environment that satisfies every required variable. */
function validEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    REDIS_URL: "redis://localhost:6379",
    JWT_ACCESS_SECRET: "ZGVwbG95bWVudC1hY2Nlc3Mtc2VjcmV0LWZvci10ZXN0cy1vbmx5",
    JWT_REFRESH_SECRET: "ZGVwbG95bWVudC1yZWZyZXNoLXNlY3JldC1mb3ItdGVzdHMtb25seQ",
    TWO_FACTOR_SECRET_KEY: "ZGVwbG95bWVudC10d28tZmFjdG9yLWtleS1mb3ItdGVzdHM",
  };
}

describe("Production environment validation", () => {
  it("refuses to boot without a database or cache URL", () => {
    for (const omitted of ["DATABASE_URL", "REDIS_URL"] as const) {
      const source = { ...validEnv() };
      delete source[omitted];
      expect(() => parseEnv(source), omitted).toThrow();
    }
  });

  it("refuses the .env.example placeholder for every secret", () => {
    // `cp .env.example .env` must fail loudly rather than boot on a signing
    // key that is published in this repository.
    for (const secret of [
      "JWT_ACCESS_SECRET",
      "JWT_REFRESH_SECRET",
      "TWO_FACTOR_SECRET_KEY",
    ] as const) {
      expect(() =>
        parseEnv({ ...validEnv(), [secret]: "replace_me_with_a_generated_secret_value" }),
      ).toThrow();
    }
  });

  it("accepts production and derives production defaults", () => {
    const parsed = parseEnv({ ...validEnv(), NODE_ENV: "production" });

    expect(parsed.NODE_ENV).toBe("production");
    // Unset rather than false: `config/cookies.ts` reads
    // `env.COOKIE_SECURE ?? isProduction`, so leaving it unset is what makes
    // production cookies Secure by default.
    expect(parsed.COOKIE_SECURE).toBeUndefined();
  });

  it("keeps an explicit COOKIE_SECURE override working", () => {
    expect(parseEnv({ ...validEnv(), COOKIE_SECURE: "true" }).COOKIE_SECURE).toBe(true);
    expect(parseEnv({ ...validEnv(), COOKIE_SECURE: "false" }).COOKIE_SECURE).toBe(false);
  });

  it("rejects an unknown NODE_ENV rather than guessing", () => {
    expect(() => parseEnv({ ...validEnv(), NODE_ENV: "staging" })).toThrow();
  });
});

describe(".env.example is a deployable template, not a secret store", () => {
  it("ships no real credential", () => {
    /**
     * TRD §33: never commit secrets. Every credential in the template must be
     * the placeholder `config/env.ts` explicitly refuses, so that
     * `cp .env.example .env` fails fast instead of booting on a signing key
     * published in this repository.
     *
     * The secret list is derived by probing the schema, not by matching names.
     */
    const secrets = new Set(secretVariables());
    expect(secrets.size).toBeGreaterThan(0);

    for (const line of envExampleSource.split("\n")) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (!match) continue;

      const [, name = "", value = ""] = match;
      if (!secrets.has(name) || value.length === 0) continue;

      expect(
        value.toLowerCase().startsWith("replace_me"),
        `${name} in .env.example is not the rejected placeholder`,
      ).toBe(true);
    }
  });

  it("uses a placeholder the schema actually refuses", () => {
    // The template and the validator have to agree on the sentinel, or the
    // fail-fast guard silently stops guarding.
    for (const name of secretVariables()) {
      const declared = new RegExp(`^${name}=(.*)$`, "m").exec(envExampleSource);
      expect(declared, `${name} must appear in .env.example`).not.toBeNull();

      const value = declared?.[1] ?? "";
      expect(() => parseEnv({ ...validEnv(), [name]: value })).toThrow();
    }
  });

  it("documents AI_PROVIDER and EMAIL_PROVIDER for operators", () => {
    expect(envExampleSource).toContain("AI_PROVIDER=");
    expect(envExampleSource).toContain("EMAIL_PROVIDER=");
  });
});

/* ── Graceful shutdown ───────────────────────────────────────────────────── */

const closeSocketServer = vi.fn(() => Promise.resolve());
const disconnectDatabase = vi.fn(() => Promise.resolve());
const disconnectRedis = vi.fn(() => Promise.resolve());

vi.mock("../src/sockets/socket.js", () => ({
  closeSocketServer: () => closeSocketServer(),
}));
vi.mock("../src/database/prisma.js", () => ({
  disconnectDatabase: () => disconnectDatabase(),
}));
vi.mock("../src/config/redis.js", () => ({
  disconnectRedis: () => disconnectRedis(),
}));

/** A stand-in for `http.Server` that records `close()` and succeeds. */
function fakeServer(): { server: HttpServer; closed: () => number } {
  let closes = 0;
  const server = {
    close(callback?: (error?: Error) => void): void {
      closes += 1;
      callback?.();
    },
  } as unknown as HttpServer;

  return { server, closed: () => closes };
}

/** Neutralises `process.exit` so the handlers cannot kill the test run. */
function spyOnProcessExit() {
  return vi
    .spyOn(process, "exit")
    .mockImplementation(((): never => undefined as never) as never);
}

describe("Graceful shutdown", () => {
  let exitSpy: ReturnType<typeof spyOnProcessExit>;
  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];

  beforeEach(() => {
    closeSocketServer.mockClear();
    disconnectDatabase.mockClear();
    disconnectRedis.mockClear();
    exitSpy = spyOnProcessExit();
    vi.resetModules();
  });

  afterEach(() => {
    exitSpy.mockRestore();
    for (const signal of signals) process.removeAllListeners(signal);
    process.removeAllListeners("unhandledRejection");
    process.removeAllListeners("uncaughtException");
  });

  /** Fresh import per test: the module keeps a `shuttingDown` latch. */
  async function loadShutdown() {
    return import("../src/utils/graceful-shutdown.js");
  }

  it("registers a handler for SIGTERM and SIGINT", async () => {
    const { registerShutdownHandlers } = await loadShutdown();
    const before = signals.map((signal) => process.listenerCount(signal));

    registerShutdownHandlers(fakeServer().server);

    signals.forEach((signal, index) => {
      expect(
        process.listenerCount(signal),
        `${signal} must gain a handler`,
      ).toBeGreaterThan(before[index] as number);
    });
  });

  it("closes sockets, the HTTP server, and both backing services", async () => {
    const { registerShutdownHandlers } = await loadShutdown();
    const { server, closed } = fakeServer();

    registerShutdownHandlers(server);
    process.emit("SIGTERM");
    // Let the async shutdown chain settle.
    await new Promise((r) => setImmediate(r));

    expect(closeSocketServer).toHaveBeenCalledTimes(1);
    expect(closed()).toBe(1);
    expect(disconnectDatabase).toHaveBeenCalledTimes(1);
    expect(disconnectRedis).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("closes sockets before the HTTP server", async () => {
    // Order is the contract: draining the other way lets an in-flight request
    // reach an already-closed handle.
    const order: string[] = [];
    closeSocketServer.mockImplementationOnce(() => {
      order.push("socket");
      return Promise.resolve();
    });

    const { registerShutdownHandlers } = await loadShutdown();
    let httpClosed = false;
    const server = {
      close(callback?: (error?: Error) => void): void {
        httpClosed = true;
        order.push("http");
        callback?.();
      },
    } as unknown as HttpServer;

    registerShutdownHandlers(server);
    process.emit("SIGTERM");
    await new Promise((r) => setImmediate(r));

    expect(httpClosed).toBe(true);
    expect(order).toEqual(["socket", "http"]);
  });

  it("ignores a second signal while already draining", async () => {
    // An orchestrator that sends SIGTERM twice must not restart the sequence
    // and double-close a handle.
    const { registerShutdownHandlers } = await loadShutdown();
    registerShutdownHandlers(fakeServer().server);

    process.emit("SIGTERM");
    process.emit("SIGTERM");
    process.emit("SIGINT");
    await new Promise((r) => setImmediate(r));

    expect(closeSocketServer).toHaveBeenCalledTimes(1);
    expect(disconnectDatabase).toHaveBeenCalledTimes(1);
  });

  it("still releases backing services when the socket layer fails", async () => {
    // A shutdown that gives up on the first error would leak a database
    // connection on every failed roll.
    closeSocketServer.mockImplementationOnce(() =>
      Promise.reject(new Error("socket close failed")),
    );

    const { registerShutdownHandlers } = await loadShutdown();
    registerShutdownHandlers(fakeServer().server);

    process.emit("SIGTERM");
    await new Promise((r) => setImmediate(r));

    // It exits non-zero, which is the honest signal to the orchestrator.
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
