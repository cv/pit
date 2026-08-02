import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import pit from "../src/index.js";

interface RenderedComponent {
  render(width: number): string[];
  invalidate(): void;
}

export interface RegisteredTool {
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: {
    properties: {
      label: { description?: string };
      code: { description?: string };
      params: { description?: string };
      saveOnly: { description?: string };
      timeoutMs: { description?: string };
    };
  };
  renderCall?: (args: any, theme: any, context: any) => RenderedComponent;
  renderResult?: (result: any, options: any, theme: any, context: any) => RenderedComponent;
  execute: (...args: any[]) => Promise<any>;
}

export let cwd: string;
export let tool: RegisteredTool;
export let sessionStart: (...args: any[]) => void;
export let sessionTree: (...args: any[]) => void;
export let beforeAgentStart: (...args: any[]) => any;
export let branchEntries: any[];
export let execMock: ReturnType<typeof vi.fn>;
export let setActiveTools: ReturnType<typeof vi.fn>;
export let functionsCommand: { handler: (args: string, ctx: any) => Promise<void> };
let sessionName: string | undefined;
let slashCommands: any[] = [];
let configuredModels: any[] = [];

export function context(overrides: Record<string, unknown> = {}) {
  return {
    cwd,
    mode: "interactive",
    model: { provider: "test", id: "model" },
    thinkingLevel: "medium",
    hasUI: true,
    isProjectTrusted: () => true,
    getContextUsage: () => ({ tokens: 1234, contextWindow: 200000, percent: 0.617 }),
    modelRegistry: {
      refresh: vi.fn(async () => undefined),
      getAll: () => configuredModels,
      getAvailable: () => configuredModels.filter((model) => model.available !== false),
      find: (provider: string, id: string) =>
        configuredModels.find((model) => model.provider === provider && model.id === id),
      hasConfiguredAuth: (model: any) => model.available !== false,
    },
    scopedModels: [],
    ui: {
      confirm: vi.fn(async () => true),
      input: vi.fn(async () => "typed"),
      select: vi.fn(async () => "b"),
      notify: vi.fn(),
      custom: vi.fn(async () => undefined),
    },
    sessionManager: {
      getSessionId: () => "test-session-id",
      getSessionFile: () => "/tmp/session.jsonl",
      getLeafId: () => branchEntries.at(-1)?.id ?? null,
      getEntries: () => branchEntries,
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

const testTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
};

type RenderContext = Record<string, unknown>;
type RenderResultOptions = { expanded: boolean; isPartial: boolean };

export function renderToolCall(args: unknown, context: RenderContext): string {
  return tool.renderCall?.(args, testTheme, context).render(200).join("\n") ?? "";
}

export function renderToolResult(
  result: unknown,
  options: RenderResultOptions,
  context: RenderContext = { isError: false },
): string {
  return (
    tool
      .renderResult?.(result, options, testTheme, { args: {}, ...context })
      .render(200)
      .join("\n") ?? ""
  );
}

export function setBranchEntries(entries: any[]): void {
  branchEntries = entries;
}

export function setSlashCommands(commands: any[]): void {
  slashCommands = commands;
}

export function setConfiguredModels(models: any[]): void {
  configuredModels = models;
}

export async function setupHarness(): Promise<void> {
  cwd = await mkdtemp(join(tmpdir(), "pit-test-"));
  branchEntries = [];
  sessionName = undefined;
  slashCommands = [];
  configuredModels = [];
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
      if (event === "before_agent_start") {
        beforeAgentStart = callback;
      }
    }),
    appendEntry: vi.fn((customType: string, data: unknown) => {
      branchEntries.push({ type: "custom", customType, data });
    }),
    setSessionName: vi.fn((name: string) => {
      sessionName = name;
    }),
    getSessionName: vi.fn(() => sessionName),
    getCommands: vi.fn(() => slashCommands),
    setModel: vi.fn(async (model: any) => model.available !== false),
    setActiveTools,
    exec: execMock,
  };
  pit(pi as any);
}

export async function cleanupHarness(): Promise<void> {
  vi.unstubAllGlobals();
  await rm(cwd, { recursive: true, force: true });
}
