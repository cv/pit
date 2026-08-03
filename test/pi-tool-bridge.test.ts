import { AgentSession, type AgentToolResult, type ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import {
  createExperimentalPiToolApi,
  installExperimentalPiToolApi,
} from "../src/experimental-pi-tool-adapter.js";

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
  const pi = {
    getActiveTools: () => options.active ?? [],
    getAllTools: () => [metadata],
  };
  const session = {
    extensionRunner: runner,
    _toolRegistry: new Map([["echo", tool]]),
  } as unknown as AgentSession;
  return {
    api: createExperimentalPiToolApi(pi, () => session),
    pi,
    session,
    emit,
    emitToolCall,
    emitToolResult,
    tool,
  };
}

describe("experimental Pi tool API adapter", () => {
  it("uses public Pi metadata APIs and enforces explicit scope", () => {
    const { api } = createHarness({ active: [] });
    expect(api.listTools()).toEqual([]);
    expect(api.listTools({ scope: "registered" })).toEqual([
      expect.objectContaining({ name: "echo", active: false, sourceInfo }),
    ]);
  });

  it("uses Pi validation, hooks, updates, and lifecycle events", async () => {
    const after = {
      content: [{ type: "text" as const, text: "transformed" }],
      details: { transformed: true },
    };
    const harness = createHarness({ after, active: ["echo"] });
    const onUpdate = vi.fn();
    const result = await harness.api.executeTool("echo", { value: "7" }, { onUpdate });

    expect(result).toMatchObject({
      toolCallId: expect.stringMatching(/^pit:/),
      content: [{ type: "text", text: "transformed" }],
      details: { transformed: true },
      isError: false,
    });
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.arrayContaining([expect.objectContaining({ text: "partial" })]),
      }),
      { toolCallId: result.toolCallId },
    );
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

  it("returns structured errors for inactive, missing, blocked, invalid, and failing tools", async () => {
    const inactive = createHarness();
    await expect(inactive.api.executeTool("echo", { value: 1 })).resolves.toMatchObject({
      isError: true,
      errorKind: "inactive",
    });
    await expect(
      inactive.api.executeTool("missing", {}, { scope: "registered" }),
    ).resolves.toMatchObject({ isError: true, errorKind: "not_found" });

    const blocked = createHarness({ before: { block: true, reason: "not allowed" } });
    await expect(
      blocked.api.executeTool("echo", { value: 1 }, { scope: "registered" }),
    ).resolves.toMatchObject({ content: [{ text: "not allowed" }], errorKind: "blocked" });

    const invalid = createHarness();
    await expect(
      invalid.api.executeTool("echo", { value: "not-a-number" }, { scope: "registered" }),
    ).resolves.toMatchObject({ isError: true, errorKind: "validation" });

    const throwing = createHarness({
      tool: {
        name: "echo",
        parameters: Type.Object({ value: Type.Number() }),
        execute: vi.fn(async () => {
          throw new Error("broken tool");
        }),
      },
    });
    await expect(
      throwing.api.executeTool("echo", { value: 1 }, { scope: "registered" }),
    ).resolves.toMatchObject({ content: [{ text: "broken tool" }], errorKind: "execution" });
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
    const result = await harness.api.executeTool(
      "echo",
      { value: 1 },
      { scope: "registered", signal: controller.signal },
    );
    expect(result).toMatchObject({
      content: [{ text: "Operation aborted" }],
      errorKind: "aborted",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves argument preparation and result fallback semantics", async () => {
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

    const result = await harness.api.executeTool(
      "echo",
      { ignored: true },
      { scope: "registered" },
    );
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

  it("matches fallback behavior for absent handlers and failing result hooks", async () => {
    const blocked = createHarness({ before: { block: true } });
    await expect(
      blocked.api.executeTool("echo", { value: 1 }, { scope: "registered" }),
    ).resolves.toMatchObject({ content: [{ text: "Tool execution was blocked" }] });

    const noHooks = createHarness({ handlers: false });
    const controller = new AbortController();
    controller.abort();
    await expect(
      noHooks.api.executeTool(
        "echo",
        { value: 1 },
        { scope: "registered", signal: controller.signal },
      ),
    ).resolves.toMatchObject({ errorKind: "aborted" });

    const failedAfter = createHarness();
    failedAfter.emitToolResult.mockRejectedValueOnce("result hook failed");
    await expect(
      failedAfter.api.executeTool("echo", { value: 1 }, { scope: "registered" }),
    ).resolves.toMatchObject({ content: [{ text: "result hook failed" }], errorKind: "hook" });
  });

  it("rejects recursive execution and stale private registry entries", async () => {
    const recursive = createHarness();
    let nestedResult: Awaited<ReturnType<typeof recursive.api.executeTool>> | undefined;
    await recursive.api.executeTool(
      "echo",
      { value: 1 },
      {
        scope: "registered",
        onUpdate: async () => {
          nestedResult = await recursive.api.executeTool(
            "echo",
            { value: 2 },
            { scope: "registered" },
          );
        },
      },
    );
    expect(nestedResult).toMatchObject({ isError: true, errorKind: "recursion" });

    const stale = createHarness();
    (stale.session as any)._toolRegistry.clear();
    await expect(stale.api.executeTool("echo", {}, { scope: "registered" })).resolves.toMatchObject(
      { isError: true, errorKind: "not_found" },
    );
  });

  it("normalizes absent tool content at the API boundary", async () => {
    const harness = createHarness({
      tool: {
        name: "echo",
        parameters: Type.Object({}),
        execute: vi.fn(async () => ({ details: {} })),
      },
    });
    await expect(
      harness.api.executeTool("echo", {}, { scope: "registered" }),
    ).resolves.toMatchObject({ content: [], isError: false });
  });

  it("validates scope at the stable API boundary", async () => {
    const { api } = createHarness();
    expect(() => api.listTools({ scope: "invalid" as any })).toThrow(
      'Tool scope must be "active" or "registered"',
    );
    await expect(api.executeTool("echo", {}, { scope: "invalid" as any })).rejects.toThrow(
      'Tool scope must be "active" or "registered"',
    );
  });

  it("isolates synchronous and asynchronous update observer failures", async () => {
    const harness = createHarness();
    await expect(
      harness.api.executeTool(
        "echo",
        { value: 1 },
        {
          scope: "registered",
          onUpdate: () => {
            throw new Error("sync observer failure");
          },
        },
      ),
    ).resolves.toMatchObject({ isError: false });
    await expect(
      harness.api.executeTool(
        "echo",
        { value: 2 },
        {
          scope: "registered",
          onUpdate: async () => {
            throw new Error("async observer failure");
          },
        },
      ),
    ).resolves.toMatchObject({ isError: false });
    expect(
      harness.emit.mock.calls.filter(([event]) => event.type === "tool_execution_end"),
    ).toHaveLength(2);
  });

  it("classifies before-hook failures and cancellation during execution", async () => {
    const failedHook = createHarness();
    failedHook.emitToolCall.mockRejectedValueOnce("hook failed");
    await expect(
      failedHook.api.executeTool("echo", { value: 1 }, { scope: "registered" }),
    ).resolves.toMatchObject({ errorKind: "hook", content: [{ text: "hook failed" }] });

    const controller = new AbortController();
    const cancelled = createHarness({
      tool: {
        name: "echo",
        parameters: Type.Object({}),
        execute: vi.fn(async () => {
          controller.abort();
          throw new Error("cancelled by tool");
        }),
      },
    });
    await expect(
      cancelled.api.executeTool("echo", {}, { scope: "registered", signal: controller.signal }),
    ).resolves.toMatchObject({ errorKind: "aborted", content: [{ text: "Operation aborted" }] });
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
      const metadata: ToolInfo = {
        name: "captured",
        description: "Captured tool",
        parameters: Type.Object({}),
        sourceInfo,
      };
      const api = installExperimentalPiToolApi({
        getActiveTools: () => ["captured"],
        getAllTools: () => [metadata],
      } as any);
      const session = {
        extensionRunner: {
          emit: vi.fn(),
          hasHandlers: () => false,
        },
        _toolRegistry: new Map([
          [
            "captured",
            {
              name: "captured",
              parameters: Type.Object({}),
              execute: vi.fn(async () => ({ content: [], details: {} })),
            },
          ],
        ]),
      } as unknown as AgentSession;
      await prototype.prompt.call(session, "capture me");
      expect(prompted).toHaveBeenCalledWith("capture me", undefined);
      expect(api.listTools()).toEqual([
        expect.objectContaining({ name: "captured", active: true }),
      ]);
      await expect(api.executeTool("captured", {})).resolves.toMatchObject({ isError: false });

      await prototype.bindExtensions.call(session, {});
      expect(bound).toHaveBeenCalled();
    } finally {
      prototype.bindExtensions = originalBindExtensions;
      prototype.prompt = originalPrompt;
    }
  });

  it("lists through public APIs before session capture but rejects execution clearly", async () => {
    const metadata: ToolInfo = {
      name: "echo",
      description: "Echo",
      parameters: Type.Object({}),
      sourceInfo,
    };
    const api = createExperimentalPiToolApi(
      { getActiveTools: () => ["echo"], getAllTools: () => [metadata] },
      () => undefined,
    );
    expect(api.listTools()).toHaveLength(1);
    await expect(api.executeTool("echo", {})).rejects.toThrow("before the agent session is bound");
  });
});
