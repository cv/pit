import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupHarness,
  renderToolCall,
  renderToolResult,
  setupHarness,
} from "./extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

describe("tool rendering", () => {
  it("renders generated TypeScript source with collapsed and expanded views", () => {
    const code = Array.from({ length: 15 }, (_, index) => `// source line ${index + 1}`).join("\n");

    const collapsed = renderToolCall(
      { label: "Render generated TypeScript", code, timeoutMs: 5000 },
      { expanded: false, argsComplete: true },
    );
    const collapsedLines = collapsed.split("\n");
    expect(collapsedLines[0]).toContain("Render generated TypeScript (15 lines, 0.0s)");
    expect(collapsedLines[0]).not.toContain("timeout=");
    expect(collapsedLines[0]).toContain("\u001b[1m");
    expect(collapsedLines[0]).toContain("› ");
    expect(collapsedLines[1]?.trim()).toBe("");
    expect(collapsed).not.toContain("source line 1");
    expect(collapsed).not.toContain("more lines");

    const expanded = renderToolCall({ code }, { expanded: true, argsComplete: true });
    expect(expanded).toContain("Run workspace task (15 lines, 0.0s)");
    expect(expanded).toContain("source line 15");
    expect(expanded).not.toContain("more lines");

    const singleLine = renderToolCall(
      { code: "return 1" },
      { expanded: false, argsComplete: true },
    );
    expect(singleLine).toContain("1 line, 0.0s)");

    const saveOnly = renderToolCall(
      { code: "async function later() {}", saveOnly: true },
      { expanded: false, argsComplete: true },
    );
    expect(saveOnly).toContain("Save later (1 line, 0.0s)");
    expect(saveOnly).toContain("save-only");

    const empty = renderToolCall({ code: "" }, { expanded: false, argsComplete: true });
    expect(empty).not.toContain("empty source");
    const expandedEmpty = renderToolCall({ code: "" }, { expanded: true, argsComplete: true });
    expect(expandedEmpty).toContain("empty source");

    const partial = renderToolCall({ code: undefined }, { expanded: false, argsComplete: false });
    expect(partial).toContain("generating... 0.0s");
    expect(partial).not.toContain("waiting for source…");
  });

  it("updates generation time every 200ms and freezes when arguments complete", () => {
    vi.useFakeTimers();
    try {
      const state = {};
      const invalidate = vi.fn();
      const context = { expanded: false, argsComplete: false, state, invalidate };

      expect(renderToolCall({ code: undefined }, context)).toContain("generating... 0.0s");
      vi.advanceTimersByTime(400);
      expect(invalidate).toHaveBeenCalledTimes(2);
      expect(renderToolCall({ code: undefined }, context)).toContain("generating... 0.4s");

      const completed = renderToolCall({ code: "return 1" }, { ...context, argsComplete: true });
      expect(completed).toContain("1 line, 0.4s");
      vi.advanceTimersByTime(400);
      expect(invalidate).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders result values as highlighted JSON", () => {
    const value = Object.fromEntries(
      Array.from({ length: 15 }, (_, index) => [`key${index + 1}`, index + 1]),
    );
    const result = {
      content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
      details: {
        value,
        truncated: false,
        functions: [
          { action: "set", name: "test", replaced: false },
          { action: "set", name: "test", replaced: true },
          { action: "run", name: "test" },
        ],
      },
    };

    const collapsed = renderToolResult(result, { expanded: false, isPartial: false });
    expect(collapsed).not.toContain("functions:");
    expect(collapsed).toContain("Returned 15 fields: key1, key2, key3 (17 lines)");
    const resultLines = collapsed.split("\n");
    expect(resultLines[0]?.trim()).toBe("");
    expect(resultLines[1]).toContain("\u001b[1m");
    expect(resultLines[1]).toContain("✓ ");
    expect(collapsed).not.toContain('"key1"');
    expect(collapsed).not.toContain("more lines");

    const expanded = renderToolResult(result, { expanded: true, isPartial: false });
    expect(expanded).toContain('"key15"');
    expect(expanded).not.toContain("more lines");

    const stringResult = renderToolResult(
      { content: [{ type: "text", text: "hello" }], details: { value: "hello", truncated: false } },
      { expanded: false, isPartial: false },
    );
    expect(stringResult).toContain("Returned string (1 line)");
    expect(stringResult).not.toContain('"hello"');

    const undefinedResult = renderToolResult(
      {
        content: [{ type: "text", text: "undefined" }],
        details: { value: undefined, truncated: false },
      },
      { expanded: false, isPartial: false },
    );
    expect(undefinedResult).toContain("Returned text (1 line)");
    expect(undefinedResult).not.toContain("undefined");

    const truncated = renderToolResult(
      {
        content: [{ type: "text", text: "partial output" }],
        details: { value: undefined, truncated: true },
      },
      { expanded: false, isPartial: false },
    );
    expect(truncated).toContain("Truncated output (truncated)");
    expect(truncated).not.toContain("partial output");
    const expandedTruncated = renderToolResult(
      {
        content: [{ type: "text", text: "partial output" }],
        details: { value: undefined, truncated: true },
      },
      { expanded: true, isPartial: false },
    );
    expect(expandedTruncated).toContain("partial output");

    const empty = renderToolResult(
      { content: [], details: undefined },
      { expanded: false, isPartial: false },
    );
    expect(empty).toContain("No returned value (0 lines)");

    const partial = renderToolResult(
      { content: [], details: undefined },
      { expanded: false, isPartial: true },
    );
    expect(partial).toContain("… Run workspace task");

    const streaming = renderToolResult(
      {
        content: [{ type: "text", text: "Running TypeScript…" }],
        details: {
          value: undefined,
          truncated: false,
          progress: [
            { id: 1, command: "npm test", status: "running", output: "test output" },
            { id: 2, command: "git status", status: "done", code: 0, output: "clean" },
            { id: 3, command: "sleep 1", status: "running", output: "" },
          ],
        },
      },
      { expanded: true, isPartial: true },
    );
    expect(streaming).toContain("[running] npm test");
    expect(streaming).toContain("test output");
    expect(streaming).toContain("[done (0)] git status");
    expect(streaming).toContain("[running] sleep 1");

    const symbolResult = renderToolResult(
      { content: [], details: { value: Symbol("value"), truncated: false } },
      { expanded: false, isPartial: false },
    );
    expect(symbolResult).toContain("Returned symbol (1 line)");
    expect(symbolResult).not.toContain("Symbol(value)");
    const expandedSymbol = renderToolResult(
      { content: [], details: { value: Symbol("value"), truncated: false } },
      { expanded: true, isPartial: false },
    );
    expect(expandedSymbol).toContain("Symbol(value)");

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const circularResult = renderToolResult(
      { content: [], details: { value: circular, truncated: false } },
      { expanded: false, isPartial: false },
    );
    expect(circularResult).toContain("Returned 1 field: self (1 line)");
    expect(circularResult).not.toContain("[object Object]");
    const expandedCircular = renderToolResult(
      { content: [], details: { value: circular, truncated: false } },
      { expanded: true, isPartial: false },
    );
    expect(expandedCircular).toContain("[object Object]");

    const error = renderToolResult(
      { content: [{ type: "text", text: "bad code" }] },
      { expanded: false, isPartial: false },
      { isError: true, args: { label: "Compile renderer", code: "" } },
    );
    expect(error).toContain("bad code");
    expect(error).toContain("✗ Compile renderer");
    expect(
      renderToolResult({ content: [] }, { expanded: false, isPartial: false }, { isError: true }),
    ).toContain("TypeScript execution failed");
  });
});
