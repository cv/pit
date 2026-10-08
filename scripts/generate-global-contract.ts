import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { type FormatConfig, format } from "oxfmt";

import { generateGlobalContract } from "../src/functions/global-contract.js";

const target = fileURLToPath(new URL("../src/generated/global-contract.d.ts", import.meta.url));

// Format with the project's own settings, so generating then running the formatter is a fixed
// point: a long declaration can't make the two undo each other.
const {
  $schema: _schema,
  ignorePatterns: _ignorePatterns,
  ...config
} = JSON.parse(
  await readFile(new URL("../.oxfmtrc.json", import.meta.url), "utf8"),
) as FormatConfig & { $schema?: string; ignorePatterns?: string[] };
const formatted = await format("global-contract.d.ts", generateGlobalContract(), config);
if (formatted.errors.length > 0) {
  // The formatter parses the contract, so a declaration string with broken syntax fails here,
  // before it can break every program's validation.
  const details = formatted.errors.map((error) => `- ${JSON.stringify(error).slice(0, 400)}`);
  process.stderr.write(`The generated contract has syntax errors:\n${details.join("\n")}\n`);
  process.exit(1);
}
const generated = formatted.code;

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
