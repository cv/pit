import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { generateGlobalContract } from "../src/functions/global-contract.js";

const target = fileURLToPath(new URL("../src/generated/global-contract.d.ts", import.meta.url));
const generated = generateGlobalContract();

if (process.argv.includes("--check")) {
  const current = await readFile(target, "utf8");
  if (current !== generated) {
    process.stderr.write(
      "src/generated/global-contract.d.ts is stale; run npm run globals:generate\n",
    );
    process.exitCode = 1;
  }
} else {
  await writeFile(target, generated, "utf8");
}
