import { spawnSync } from "node:child_process";

const jqAvailable = spawnSync("jq", ["--version"], { stdio: "ignore" }).status === 0;

/**
 * Skips suites that run real jq programs, which a stub could not verify, when jq is not on
 * PATH locally. CI always runs them, so a missing jq fails there instead of passing by skipping.
 */
export const skipWithoutJq = !jqAvailable && !process.env.CI;

if (skipWithoutJq) {
  console.warn(
    "jq is not on PATH; skipping the jq-backed workflow suites. Install jq to run them.",
  );
}
