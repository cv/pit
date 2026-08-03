import { describe, expect, it, vi } from "vitest";
import type { PiToolBridge } from "../src/pi-tool-bridge.js";
import { createToolsCapabilityHandler } from "../src/tools-capability-handler.js";

const sourceInfo = {
  path: "/extension.ts",
  source: "extension.ts",
  scope: "temporary" as const,
  origin: "top-level" as const,
};

function bridge(): PiToolBridge {
  return {
    list: () => [
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
    ],
    call: vi.fn(async () => ({
      content: [{ type: "text" as const, text: "called" }],
      details: {},
      isError: false,
    })),
  };
}

describe("tools capability", () => {
  it("filters and bounds tool metadata", async () => {
    const handler = createToolsCapabilityHandler(bridge());
    await expect(
      handler(
        "list",
        [{ activeOnly: true, query: "beta", limit: 1 }],
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      tools: [expect.objectContaining({ name: "beta", active: true })],
      truncated: false,
    });
  });

  it("uses list defaults and preserves optional prompt guidance", async () => {
    const handler = createToolsCapabilityHandler(bridge());
    await expect(handler("list", [], new AbortController().signal)).resolves.toMatchObject({
      tools: [
        { name: "alpha", active: false },
        { name: "beta", active: true, promptGuidelines: ["Use beta"] },
      ],
      truncated: false,
    });
  });

  it("calls tools with object arguments and forwards cancellation", async () => {
    const toolBridge = bridge();
    const handler = createToolsCapabilityHandler(toolBridge);
    const signal = new AbortController().signal;
    await expect(handler("call", ["beta", { value: 1 }], signal)).resolves.toMatchObject({
      isError: false,
    });
    expect(toolBridge.call).toHaveBeenCalledWith("beta", { value: 1 }, signal);
  });

  it("rejects recursion and invalid arguments", async () => {
    const handler = createToolsCapabilityHandler(bridge());
    await expect(handler("call", ["typescript", {}], new AbortController().signal)).rejects.toThrow(
      "cannot call itself",
    );
    await expect(handler("call", ["beta", "bad"], new AbortController().signal)).rejects.toThrow(
      "tool arguments must be an object",
    );
    await expect(
      handler("list", [{ activeOnly: "yes" }], new AbortController().signal),
    ).rejects.toThrow("options.activeOnly must be a boolean");
  });
});
