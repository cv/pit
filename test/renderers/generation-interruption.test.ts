import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderTypeScriptToolCall } from "../../src/renderers/typescript-tool-call.js";
import { renderTypeScriptToolResult } from "../../src/renderers/typescript-tool.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
type Context = Parameters<typeof renderTypeScriptToolResult>[3];
beforeEach(() => initTheme("dark"));

describe("interrupted tool generation", () => {
  it.each([undefined, null, {}])("renders an empty streamed argument object safely: %s", (args) => {
    const output = renderTypeScriptToolCall(
      args,
      theme,
      { expanded: false, argsComplete: false, executionStarted: false, isPartial: true },
      new Map(),
    )
      .render(100)
      .map(stripTerminalSequences)
      .join("\n");
    expect(output).toContain("TypeScript (generating...");
  });

  it.each<{ name: string; context: Context; details?: unknown; label: string; timing: boolean }>([
    {
      name: "live empty call",
      context: { args: {}, executionStarted: false, argsComplete: false },
      label: "Call interrupted — not executed",
      timing: false,
    },
    {
      name: "missing arguments",
      context: { executionStarted: false, argsComplete: false },
      label: "Call interrupted — not executed",
      timing: false,
    },
    {
      name: "execution was attempted",
      context: { args: {}, executionStarted: true, argsComplete: false },
      label: "Failed",
      timing: true,
    },
    {
      name: "arguments were complete",
      context: { args: {}, executionStarted: false, argsComplete: true },
      label: "Failed",
      timing: true,
    },
    {
      name: "legacy replay with executable source",
      context: { args: { code: "async () => 1" }, executionStarted: false, argsComplete: false },
      label: "Failed",
      timing: true,
    },
    {
      name: "structured execution failure",
      context: { args: {}, executionStarted: false, argsComplete: false },
      details: { failure: { kind: "timeout", rootError: "deadline reached", functionPath: [] } },
      label: "Timed out",
      timing: true,
    },
    {
      name: "unknown legacy lifecycle flags",
      context: { args: {} },
      label: "Failed",
      timing: true,
    },
  ])("distinguishes $name", ({ context, details, label, timing }) => {
    const output = renderTypeScriptToolResult(
      { content: [{ type: "text", text: "UPSTREAM_CONNECTION_RESET" }], details },
      { expanded: true, isPartial: false },
      theme,
      { ...context, isError: true },
    )
      .render(120)
      .map((row) => stripTerminalSequences(row).trimEnd())
      .join("\n")
      .trimStart();
    const header = output.split("\n")[0] ?? "";
    expect(header).toContain(`✗ ${label}`);
    expect(header.includes("(")).toBe(timing);
  });

  it("stops generation animation without inventing an execution duration", () => {
    vi.useFakeTimers();
    try {
      const context = {
        args: {},
        state: {},
        expanded: false,
        argsComplete: false,
        executionStarted: false,
        isPartial: true,
        isError: false,
        invalidate: vi.fn(),
      };
      renderTypeScriptToolCall({}, theme, context, new Map());
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(400);
      context.isPartial = false;
      context.isError = true;
      renderTypeScriptToolCall({}, theme, context, new Map());
      const output = renderTypeScriptToolResult(
        { content: [{ type: "text", text: "transport reset" }] },
        { expanded: false, isPartial: false },
        theme,
        context,
      )
        .render(120)
        .map(stripTerminalSequences)
        .join("\n");
      expect(output).toContain("not executed");
      expect(output).not.toContain("0.0s");
      expect(output).toContain("transport reset");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
