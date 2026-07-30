import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import pit from "../src/index.js";

export interface RegisteredTool {
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: {
    properties: {
      code: { description?: string };
      params: { description?: string };
      timeoutMs: { description?: string };
    };
  };
  renderCall?: (args: any, theme: any, context: any) => { render: (width: number) => string[] };
  renderResult?: (
    result: any,
    options: any,
    theme: any,
    context: any,
  ) => { render: (width: number) => string[] };
  execute: (...args: any[]) => Promise<any>;
}

export let cwd: string;
export let tool: RegisteredTool;
export let sessionStart: (...args: any[]) => void;
export let sessionTree: (...args: any[]) => void;
export let branchEntries: any[];
export let execMock: ReturnType<typeof vi.fn>;
export let setActiveTools: ReturnType<typeof vi.fn>;
export let functionsCommand: { handler: (args: string, ctx: any) => Promise<void> };

export function context(overrides: Record<string, unknown> = {}) {
  return {
    cwd,
    mode: "interactive",
    model: { provider: "test", id: "model" },
    thinkingLevel: "medium",
    hasUI: true,
    ui: {
      confirm: vi.fn(async () => true),
      input: vi.fn(async () => "typed"),
      select: vi.fn(async () => "b"),
      notify: vi.fn(),
      custom: vi.fn(async () => undefined),
    },
    sessionManager: {
      getSessionFile: () => "/tmp/session.jsonl",
      getBranch: () => branchEntries,
    },
    ...overrides,
  };
}

export async function run(code: string, ctx = context(), signal?: AbortSignal) {
  return tool.execute("call-id", { code }, signal, undefined, ctx);
}

export async function runWithParams(code: string, params: unknown, ctx = context()) {
  return tool.execute("call-id", { code, params }, undefined, undefined, ctx);
}

export async function value(code: string, ctx = context()) {
  return (await run(code, ctx)).details.value;
}

export function setBranchEntries(entries: any[]): void {
  branchEntries = entries;
}

export async function setupHarness(): Promise<void> {
  cwd = await mkdtemp(join(tmpdir(), "pit-test-"));
  branchEntries = [];
  execMock = vi.fn(async () => ({ stdout: "shell out\n", stderr: "", code: 0 }));
  setActiveTools = vi.fn();
  const pi = {
    registerTool: vi.fn((registered: RegisteredTool) => {
      tool = registered;
    }),
    registerCommand: vi.fn((name: string, command: typeof functionsCommand) => {
      if (name === "functions") {
        functionsCommand = command;
      }
    }),
    on: vi.fn((event: string, callback: (...args: any[]) => void) => {
      if (event === "session_start") {
        sessionStart = callback;
      }
      if (event === "session_tree") {
        sessionTree = callback;
      }
    }),
    appendEntry: vi.fn((customType: string, data: unknown) => {
      branchEntries.push({ type: "custom", customType, data });
    }),
    setActiveTools,
    exec: execMock,
  };
  pit(pi as any);
}

export async function cleanupHarness(): Promise<void> {
  vi.unstubAllGlobals();
  await rm(cwd, { recursive: true, force: true });
}
