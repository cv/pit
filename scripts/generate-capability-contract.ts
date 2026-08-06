import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { generateCapabilityContract } from "../src/capabilities/registry.js";

const target = fileURLToPath(new URL("../src/generated/capability-contract.d.ts", import.meta.url));
const generated = generateCapabilityContract();

if (process.argv.includes("--check")) {
  const current = await readFile(target, "utf8");
  if (current !== generated) {
    process.stderr.write(
      "src/generated/capability-contract.d.ts is stale; run npm run capabilities:generate\n",
    );
    process.exitCode = 1;
  }
} else {
  await writeFile(target, generated, "utf8");
}
