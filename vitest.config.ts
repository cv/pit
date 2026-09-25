import { availableParallelism } from "node:os";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: ["minimal"],
    // Each worker pays TypeScript startup and one guest compilation; on 20 cores, 8 workers
    // finish the suite faster than 19.
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
