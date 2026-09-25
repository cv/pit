import { availableParallelism } from "node:os";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: ["minimal"],
    // Each Wasmtime execution compiles the guest component (#136); beyond a few workers,
    // concurrent compilation only oversubscribes the CPU and inflates individual test times.
    maxWorkers: Math.min(8, availableParallelism()),

    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "test/**"],
      thresholds: {
        statements: 98,
        branches: 98,
        functions: 98,
        lines: 98,
      },
    },
  },
});
