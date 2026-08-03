import { describe, expect, it, vi } from "vitest";
import type { PiToolExecutionApi } from "../src/pi-tool-api.js";
import { createToolsCapabilityHandler } from "../src/tools-capability-handler.js";

const sourceInfo = {
  path: "/extension.ts",
  source: "extension.ts",
  scope: "temporary" as const,
  origin: "top-level" as const,
};

function toolApi(): PiToolExecutionApi {
  const tools = [
    {
      name: "alpha",
      description: "First extension tool",
      parameters: { type: "object" },
      active: false,
      sourceInfo,
    },
    {
      name: "beta",
      description: "Second extension tool",
      parameters: { type: "object" },
      active: true,
      sourceInfo,
      promptGuidelines: ["Use beta"],
    },
  ];
  return {
    listTools: vi.fn(({ scope = "active" } = {}) =>
      tools.filter((tool) => scope === "registered" || tool.active),
    ),
    executeTool: vi.fn(async (_name, _args, options) => {
      await options?.onUpdate?.(
        { content: [{ type: "text", text: "partial" }], details: {} },
        { toolCallId: "call-1" },
      );
      return {
        toolCallId: "call-1",
        content: [{ type: "text" as const, text: "called" }],
        details: {},
        isError: false,
      };
    }),
  };
}

describe("tools capability", () => {
  it("filters and bounds registered tool metadata", async () => {
    const api = toolApi();
    const handler = createToolsCapabilityHandler(api);
    await expect(
      handler(
        "list",
        [{ scope: "registered", query: "beta", limit: 1 }],
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      tools: [expect.objectContaining({ name: "beta", active: true })],
      truncated: false,
    });
    expect(api.listTools).toHaveBeenCalledWith({ scope: "registered" });
  });

  it("defaults listing to active tools and preserves prompt guidance", async () => {
    const handler = createToolsCapabilityHandler(toolApi());
    await expect(handler("list", [], new AbortController().signal)).resolves.toMatchObject({
      tools: [{ name: "beta", active: true, promptGuidelines: ["Use beta"] }],
      truncated: false,
    });
    await expect(
      handler("list", [{ scope: "registered" }], new AbortController().signal),
    ).resolves.toMatchObject({
      tools: [
        { name: "alpha", active: false },
        { name: "beta", active: true, promptGuidelines: ["Use beta"] },
      ],
    });
  });

  it("forwards scope, cancellation, updates, and completion", async () => {
    const api = toolApi();
    const progress = vi.fn();
    const handler = createToolsCapabilityHandler(api, progress);
    const signal = new AbortController().signal;
    await expect(
      handler("call", ["beta", { value: 1 }, { scope: "registered" }], signal),
    ).resolves.toMatchObject({ isError: false, toolCallId: "call-1" });
    expect(api.executeTool).toHaveBeenCalledWith(
      "beta",
      { value: 1 },
      expect.objectContaining({ scope: "registered", signal, onUpdate: expect.any(Function) }),
    );
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "update", name: "beta", toolCallId: "call-1" }),
    );
    expect(progress).toHaveBeenLastCalledWith({
      phase: "end",
      name: "beta",
      toolCallId: "call-1",
      isError: false,
    });
  });

  it("projects optional tool result fields and normalizes absent content", async () => {
    const api = toolApi();
    vi.mocked(api.executeTool).mockResolvedValueOnce({
      toolCallId: "call-error",
      content: undefined as any,
      details: undefined as any,
      usage: { tokens: 3 } as any,
      addedToolNames: ["dynamic"],
      terminate: true,
      isError: true,
      errorKind: "execution",
    });
    const handler = createToolsCapabilityHandler(api);
    await expect(handler("call", ["beta", {}], new AbortController().signal)).resolves.toEqual({
      toolCallId: "call-error",
      content: [],
      usage: { tokens: 3 },
      addedToolNames: ["dynamic"],
      terminate: true,
      isError: true,
      errorKind: "execution",
    });
  });

  it("rejects non-JSON extension result details at the Pit boundary", async () => {
    const api = toolApi();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    vi.mocked(api.executeTool).mockResolvedValueOnce({
      toolCallId: "call-cyclic",
      content: [],
      details: cyclic,
      isError: false,
    });
    const progress = vi.fn();
    const handler = createToolsCapabilityHandler(api, progress);
    await expect(handler("call", ["beta", {}], new AbortController().signal)).rejects.toThrow(
      "tool result details is not JSON-safe",
    );
    expect(progress).toHaveBeenLastCalledWith({
      phase: "end",
      name: "beta",
      toolCallId: "call-cyclic",
      isError: true,
    });
  });

  it("rejects direct recursion and invalid arguments", async () => {
    const handler = createToolsCapabilityHandler(toolApi());
    await expect(handler("call", ["typescript", {}], new AbortController().signal)).rejects.toThrow(
      "cannot call itself",
    );
    await expect(handler("call", ["beta", "bad"], new AbortController().signal)).rejects.toThrow(
      "tool arguments must be an object",
    );
    await expect(
      handler("list", [{ scope: "everything" }], new AbortController().signal),
    ).rejects.toThrow('options.scope must be "active" or "registered"');
  });
});
