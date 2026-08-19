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
    coverage: {
      provider: "v8",
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/server.ts", "src/**/index.ts"],
    },
  },
});
