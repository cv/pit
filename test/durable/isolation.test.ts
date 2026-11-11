import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, "../..");

// Pi provides these packages to its extensions; a pi-durable host has none of them.
const BLOCKER = `import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^(@earendil-works\\/(pi-coding-agent|pi-tui)|typebox)(\\/|$)/.test(specifier)) {
      throw new Error("blocked import: " + specifier + " from " + context.parentURL);
    }
    return nextResolve(specifier, context);
  },
});
`;

let directory: string;
let blocker: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "pit-durable-isolation-"));
  blocker = join(directory, "block-pi.mjs");
  await writeFile(blocker, BLOCKER);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** Imports a source module in a fresh Node process where Pi's packages cannot be resolved. */
function importWithoutPi(entry: string, expression: string) {
  const url = pathToFileURL(join(ROOT, entry)).href;
  return run(
    process.execPath,
    [
      "--import",
      pathToFileURL(join(ROOT, "scripts/typescript-resolve.mjs")).href,
      "--import",
      pathToFileURL(blocker).href,
      "--input-type=module",
      "--eval",
      `const module = await import(${JSON.stringify(url)}); console.log(JSON.stringify(${expression}));`,
    ],
    { cwd: ROOT },
  );
}

describe("the pi-durable entry", () => {
  it("loads without Pi's coding agent, TUI, or TypeBox", async () => {
    const { stdout } = await importWithoutPi(
      "src/durable/index.ts",
      "module.createPitDurableExtension().tools.map((tool) => tool.name)",
    );
    expect(JSON.parse(stdout)).toEqual(["typescript"]);
  });

  it("is checked by a blocker that rejects the Pi extension's imports", async () => {
    await expect(importWithoutPi("src/index.ts", "typeof module.default")).rejects.toThrow(
      /blocked import: (@earendil-works\/pi-(coding-agent|tui)|typebox)/,
    );
  });
});
