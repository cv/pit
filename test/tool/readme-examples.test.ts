import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { getNamedFunctionName } from "../../src/functions/source.js";
import { prepareSandboxProgram } from "../../src/sandbox/program.js";
import { formatTypeScriptSource } from "../../src/tool/source-formatter.js";

const readme = await readFile("README.md", "utf8");
const examples: Array<{ name: string; source: string; input?: unknown; functionId?: string }> = [];
for (const [index, match] of [...readme.matchAll(/```(ts|json)\n([\s\S]*?)```/g)].entries()) {
  if (match[1] === "ts") {
    examples.push({ name: `TypeScript block ${index + 1}`, source: match[2] as string });
  } else {
    const example = JSON.parse(match[2] as string);
    if (typeof example.code === "string")
      examples.push({
        name: `JSON tool example ${index + 1}`,
        source: example.code,
        ...(example.params === undefined ? {} : { input: example.params }),
        ...(example.functionId ? { functionId: example.functionId } : {}),
      });
  }
}

describe("release README examples", () => {
  it.each(examples)(
    "validates $name without executing host effects",
    async ({ source, input, functionId }) => {
      const formatted = await formatTypeScriptSource(source);
      const name = getNamedFunctionName(formatted);
      const id = functionId ?? name;
      const sessionFunctions = new Map([
        [
          "runTests",
          "async function runTests({ npm: { test } }, input: { coverage?: boolean } = {}) { return test({ coverage: input.coverage, raise: true }); }",
        ],
      ]);
      sessionFunctions.set(
        "company.check",
        "async function check({}, input: { value: number }) { return input.value * 2; }",
      );
      if (id) sessionFunctions.set(id, formatted);
      const program = await prepareSandboxProgram(formatted, {
        sessionFunctions,
        ...(input === undefined ? {} : { input }),
        ...(id ? { definition: { id, layer: "session" as const } } : {}),
      });
      expect(program.compiled.length).toBeGreaterThan(0);
    },
  );
});
