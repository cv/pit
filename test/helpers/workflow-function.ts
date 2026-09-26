import { appendFile, readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

import ts from "typescript";

// Execute trusted repository source with ordinary injected fakes. The resource tests
// separately validate contextual types and load the complete saved-function graph.
// A dotted identifier maps to a directory per namespace; the file declares the last segment.
export async function loadWorkflowFunction(id: string) {
  const segments = id.split(".");
  const name = segments.at(-1) ?? id;
  const path = `.pi/functions/${segments.join("/")}.ts`;
  const source = await mutated(path, await readFile(path, "utf8"));
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  });
  return runInNewContext(`${outputText}\n${name}`, { setTimeout, Date }) as (
    dependencies: Record<string, unknown>,
    input?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
}

/**
 * tests.probeMutation's counterfactual for workflow sources: they are read here, not imported
 * through Vite, so its transform cannot reach them. The mutation must match exactly once, and the
 * marker file records that it was applied.
 */
async function mutated(path: string, source: string): Promise<string> {
  const raw = process.env.PIT_WORKFLOW_MUTATION;
  if (raw === undefined) return source;
  const mutation = JSON.parse(raw) as {
    path: string;
    before: string;
    after: string;
    markerFile: string;
  };
  if (mutation.path !== path) return source;
  if (source.split(mutation.before).length !== 2) {
    throw new Error("Expected exactly one audit mutation match");
  }
  await appendFile(mutation.markerFile, `${path}\n`);
  return source.replace(mutation.before, () => mutation.after);
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
