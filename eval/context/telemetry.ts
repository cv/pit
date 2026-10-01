import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";

import ts from "typescript";

const run = promisify(execFile);

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** The `context` section of `sessions.analyze()`; see .pi/functions/README.md. */
export interface ContextTelemetry {
  requests: number;
  usage: Usage;
  peakPromptTokens: number;
  compactions: { total: number; modelRequested: number; tokensBefore: number; usage: Usage };
  edits: {
    total: number;
    byOperation: Record<string, number>;
    noteActions: Record<string, number>;
    tokensFreed: number;
    reprefillTokens: number;
  };
  notices: {
    shown: number;
    byLevel: Record<string, number>;
    followed: number;
    followWindowTurns: number;
  };
  churn: { inspectedRemovedEntries: number; reeditedEntries: number };
  sessionCalls: Record<string, number>;
}

export interface SessionAudit {
  toolCalls: number;
  failures: number;
  workflowFailures: number;
  categories: Record<string, number>;
  context: ContextTelemetry;
}

type Workflow = (dependencies: Record<string, unknown>, input?: unknown) => Promise<unknown>;

/** Loads a trusted project function from source, as Pit's workflow tests do. */
async function loadWorkflow(root: string, id: string): Promise<Workflow> {
  const segments = id.split(".");
  const source = await readFile(`${join(root, ".pi", "functions", ...segments)}.ts`, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  });
  return runInNewContext(`${outputText}\n${segments.at(-1)}`, { setTimeout, Date }) as Workflow;
}

async function execFileResult(program: string, args: string[]) {
  try {
    const { stdout, stderr } = await run(program, args, { maxBuffer: 64 * 1024 * 1024 });
    return { stdout, stderr, code: 0, truncated: false };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; code?: unknown };
    return {
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? String(error),
      code: typeof failed.code === "number" ? failed.code : 1,
      truncated: false,
    };
  }
}

/**
 * Audits a recorded session with the repository's `sessions.analyze()`, so the benchmark and
 * real sessions share one definition of each metric. Requires jq on PATH.
 */
export async function auditSession(root: string, file: string): Promise<SessionAudit> {
  const [jq, readEvents, analyze] = await Promise.all(
    ["jq", "sessions.readEvents", "sessions.analyze"].map((id) => loadWorkflow(root, id)),
  );
  if (!jq || !readEvents || !analyze) throw new Error("Could not load the session audit");
  const query = (input: unknown) => jq({ shell: { execFile: execFileResult } }, input);
  const events = (input: unknown) => readEvents({ jq: query }, input);
  return (await analyze(
    { context: { get: async () => ({ sessionFile: file }) }, sessions: { readEvents: events } },
    { file, examples: 5 },
  )) as SessionAudit;
}
