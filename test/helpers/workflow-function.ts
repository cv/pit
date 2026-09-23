import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

import ts from "typescript";

// Execute trusted repository source with ordinary injected fakes. The resource tests
// separately validate contextual types and load the complete saved-function graph.
export async function loadWorkflowFunction(name: string) {
  const source = await readFile(`.pi/functions/${name}.ts`, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  });
  return runInNewContext(`${outputText}\n${name}`, { setTimeout, Date }) as (
    dependencies: Record<string, unknown>,
    input?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
}

export function processResult(
  overrides: Partial<{
    stdout: string;
    stderr: string;
    code: number;
    truncated: boolean;
  }> = {},
) {
  return { stdout: "", stderr: "", code: 0, truncated: false, ...overrides };
}
