import { AgentSession, type AgentToolResult, type ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createPiToolBridge, installPiToolBridge } from "../src/pi-tool-bridge.js";

const sourceInfo = {
  path: "/extension.ts",
  source: "extension.ts",
  scope: "temporary" as const,
  origin: "top-level" as const,
};

function createHarness(
  options: {
    tool?: Record<string, unknown>;
    before?: unknown;
    after?: unknown;
    active?: string[];
    handlers?: boolean;
  } = {},
) {
  const emit = vi.fn(async (_event: { type: string }) => undefined);
  const emitToolCall = vi.fn(async () => options.before);
  const emitToolResult = vi.fn(async () => options.after);
  const runner = {
    emit,
    emitToolCall,
    emitToolResult,
    hasHandlers: (name: string) =>
      (options.handlers ?? true) && (name === "tool_call" || name === "tool_result"),
  };
  const tool = options.tool ?? {
    name: "echo",
    label: "Echo",
    description: "Echo a numeric value",
    parameters: Type.Object({ value: Type.Number() }),
    async execute(
      _id: string,
      args: { value: number },
      _signal?: AbortSignal,
      update?: (partial: AgentToolResult<unknown>) => void,
    ) {
      update?.({ content: [{ type: "text", text: "partial" }], details: { partial: true } });
      return {
        content: [{ type: "text" as const, text: String(args.value) }],
        details: { value: args.value },
      };
    },
  };
  const metadata: ToolInfo = {
    name: "echo",
    description: "Echo a numeric value",
    parameters: Type.Object({ value: Type.Number() }),
    sourceInfo,
    promptGuidelines: ["Use echo for numeric values"],
  };
  const session = {
    extensionRunner: runner,
    getActiveToolNames: () => options.active ?? [],
    getAllTools: () => [metadata],
    _toolRegistry: new Map([["echo", tool]]),
  } as unknown as AgentSession;
  return { bridge: createPiToolBridge(() => session), emit, emitToolCall, emitToolResult, tool };
}

describe("Pi tool bridge", () => {
  it("lists live registry metadata with active state", () => {
    const { bridge } = createHarness({ active: ["echo"] });
    expect(bridge.list()).toEqual([
      expect.objectContaining({ name: "echo", active: true, sourceInfo }),
    ]);
  });

  it("uses Pi validation, hooks, updates, and lifecycle events", async () => {
    const after = {
      content: [{ type: "text" as const, text: "transformed" }],
      details: { transformed: true },
    };
    const harness = createHarness({ after });
    const result = await harness.bridge.call("echo", { value: "7" });

    expect(result).toMatchObject({
      content: [{ type: "text", text: "transformed" }],
      details: { transformed: true },
      isError: false,
    });
    expect(harness.emitToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "echo", input: { value: 7 } }),
    );
    expect(harness.emitToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "echo", input: { value: 7 }, isError: false }),
    );
    expect(harness.emit.mock.calls.map(([event]) => event.type)).toEqual([
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
    ]);
  });

  it("returns core-style error results for blocking, validation, execution, and missing tools", async () => {
    const blocked = createHarness({ before: { block: true, reason: "not allowed" } });
    await expect(blocked.bridge.call("echo", { value: 1 })).resolves.toMatchObject({
      content: [{ text: "not allowed" }],
      isError: true,
    });

    const invalid = createHarness();
    await expect(invalid.bridge.call("echo", { value: "not-a-number" })).resolves.toMatchObject({
      isError: true,
    });

    const throwing = createHarness({
      tool: {
        name: "echo",
        parameters: Type.Object({ value: Type.Number() }),
        execute: vi.fn(async () => {
          throw new Error("broken tool");
        }),
      },
    });
    await expect(throwing.bridge.call("echo", { value: 1 })).resolves.toMatchObject({
      content: [{ text: "broken tool" }],
      isError: true,
    });
    await expect(throwing.bridge.call("missing", {})).resolves.toMatchObject({
      content: [{ text: "Tool missing not found" }],
      isError: true,
    });
  });

  it("propagates cancellation before execution", async () => {
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const harness = createHarness({
      tool: {
        name: "echo",
        parameters: Type.Object({ value: Type.Number() }),
        execute,
      },
    });
    const controller = new AbortController();
    controller.abort();
    const result = await harness.bridge.call("echo", { value: 1 }, controller.signal);
    expect(result).toMatchObject({ content: [{ text: "Operation aborted" }], isError: true });
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves core argument preparation and result fallback semantics", async () => {
    let lateUpdate: ((partial: AgentToolResult<unknown>) => void) | undefined;
    const execute = vi.fn(
      async (
        _id: string,
        args: Record<string, unknown>,
        _signal?: AbortSignal,
        update?: (partial: AgentToolResult<unknown>) => void,
      ) => {
        lateUpdate = update;
        return {
          content: [{ type: "text" as const, text: String(args.value) }],
          details: { original: true },
          usage: {
            input: 1,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 3,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
      },
    );
    const harness = createHarness({
      tool: {
        name: "echo",
        parameters: Type.Object({ value: Type.Number() }),
        prepareArguments: () => ({ value: "9" }),
        execute,
      },
      after: { isError: true },
    });

    const result = await harness.bridge.call("echo", { ignored: true });
    lateUpdate?.({ content: [], details: {} });
    expect(execute).toHaveBeenCalledWith(
      expect.stringMatching(/^pit:/),
      { value: 9 },
      undefined,
      expect.any(Function),
    );
    expect(result).toMatchObject({
      content: [{ text: "9" }],
      details: { original: true },
      usage: { input: 1 },
      isError: true,
    });
  });

  it("matches core fallback behavior for absent handlers and failing result hooks", async () => {
    const blocked = createHarness({ before: { block: true } });
    await expect(blocked.bridge.call("echo", { value: 1 })).resolves.toMatchObject({
      content: [{ text: "Tool execution was blocked" }],
      isError: true,
    });

    const noHooks = createHarness({ handlers: false });
    const controller = new AbortController();
    controller.abort();
    await expect(
      noHooks.bridge.call("echo", { value: 1 }, controller.signal),
    ).resolves.toMatchObject({
      content: [{ text: "Operation aborted" }],
      isError: true,
    });

    const failedAfter = createHarness();
    failedAfter.emitToolResult.mockRejectedValueOnce("result hook failed");
    await expect(failedAfter.bridge.call("echo", { value: 1 })).resolves.toMatchObject({
      content: [{ text: "result hook failed" }],
      isError: true,
    });
  });

  it("captures a live AgentSession through binding or the next prompt", async () => {
    const prototype = AgentSession.prototype;
    const originalBindExtensions = prototype.bindExtensions;
    const originalPrompt = prototype.prompt;
    const bound = vi.fn(async () => undefined);
    const prompted = vi.fn(async () => undefined);
    prototype.bindExtensions = bound;
    prototype.prompt = prompted;
    try {
      const bridge = installPiToolBridge();
      const session = {
        getActiveToolNames: () => ["captured"],
        getAllTools: () => [
          {
            name: "captured",
            description: "Captured tool",
            parameters: Type.Object({}),
            sourceInfo,
          },
        ],
      } as unknown as AgentSession;
      await prototype.prompt.call(session, "capture me");
      expect(prompted).toHaveBeenCalledWith("capture me", undefined);
      expect(bridge.list()).toEqual([expect.objectContaining({ name: "captured", active: true })]);

      await prototype.bindExtensions.call(session, {});
      expect(bound).toHaveBeenCalled();
      expect(installPiToolBridge().list()).toHaveLength(1);
    } finally {
      prototype.bindExtensions = originalBindExtensions;
      prototype.prompt = originalPrompt;
    }
  });

  it("fails clearly before a live session is captured", () => {
    const bridge = createPiToolBridge(() => undefined);
    expect(() => bridge.list()).toThrow("before the agent session is bound");
  });
});
