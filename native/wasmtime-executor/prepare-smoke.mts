import { writeFile } from "node:fs/promises";

import { prepareSandboxProgram } from "../../src/sandbox/program.js";

const output = process.argv[2];
if (!output) throw new Error("output path is required");

const program = await prepareSandboxProgram(
  "async ({ context: { get } }, input: { value: number }) => ({ context: await get(), input })",
  { input: { value: 42 } },
);
await writeFile(output, JSON.stringify({ program }));
