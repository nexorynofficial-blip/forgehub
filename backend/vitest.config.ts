import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    // Env validation exits the process on failure, so a leaked bad env in one
    // file would kill the whole run — isolate files into separate processes.
    pool: "forks",
    /**
     * Raised from Vitest's 5s/10s defaults.
     *
     * Not masking a slow implementation. The integration suites share one real
     * PostgreSQL, and every test user costs two Argon2id operations at the
     * OWASP profile `utils/password.ts` pins (19 MiB, t=2) — a register hash
     * plus a login verify. Under `forks` those costs land concurrently across
     * 30+ files, and at the old defaults tests began timing out in suites
     * nobody had touched, non-deterministically, while passing in isolation.
     *
     * No assertion is affected; only the wall-clock allowance is.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/server.ts", "src/**/index.ts"],
    },
  },
});
