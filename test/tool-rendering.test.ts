import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    expect(collapsed).toContain("Render generated TypeScript (15 lines) timeout=5000ms");
    expect(collapsed).toContain("source line 1");
    expect(collapsed).not.toContain("source line 15");
    expect(collapsed).toContain("3 more lines (Ctrl+O to expand)");

    const expanded = renderToolCall({ code }, { expanded: true, argsComplete: true });
    expect(expanded).toContain("Run workspace task (15 lines)");
    expect(expanded).toContain("source line 15");
    expect(expanded).not.toContain("more lines");

    const singleLine = renderToolCall(
      { code: "return 1" },
      { expanded: false, argsComplete: true },
    );
    expect(singleLine).toContain("1 line)");

    const saveOnly = renderToolCall(
      { code: "async function later() {}", saveOnly: true },
      { expanded: false, argsComplete: true },
    );
    expect(saveOnly).toContain("Save later (1 line)");
    expect(saveOnly).toContain("save-only");

    const empty = renderToolCall({ code: "" }, { expanded: false, argsComplete: true });
    expect(empty).toContain("empty source");

    const partial = renderToolCall({ code: undefined }, { expanded: false, argsComplete: false });
    expect(partial).toContain("generating…");
    expect(partial).toContain("waiting for source…");
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
    expect(collapsed).toContain("functions: saved test, replaced test, ran test");
    expect(collapsed).toContain("Returned 15 fields: key1, key2, key3 (17 lines)");
    expect(collapsed).toContain('"key1"');
    expect(collapsed).not.toContain('"key15"');
    expect(collapsed).toContain("5 more lines (Ctrl+O to expand)");

    const expanded = renderToolResult(result, { expanded: true, isPartial: false });
    expect(expanded).toContain('"key15"');
    expect(expanded).not.toContain("more lines");

    const stringResult = renderToolResult(
      { content: [{ type: "text", text: "hello" }], details: { value: "hello", truncated: false } },
      { expanded: false, isPartial: false },
    );
    expect(stringResult).toContain('"hello"');
    expect(stringResult).toContain("1 line)");

    const undefinedResult = renderToolResult(
      {
        content: [{ type: "text", text: "undefined" }],
        details: { value: undefined, truncated: false },
      },
      { expanded: false, isPartial: false },
    );
    expect(undefinedResult).toContain("undefined");

    const truncated = renderToolResult(
      {
        content: [{ type: "text", text: "partial output" }],
        details: { value: undefined, truncated: true },
      },
      { expanded: false, isPartial: false },
    );
    expect(truncated).toContain("Truncated output (truncated)");
    expect(truncated).toContain("partial output");

    const empty = renderToolResult(
      { content: [], details: undefined },
      { expanded: false, isPartial: false },
    );
    expect(empty).toContain("no result");

    const partial = renderToolResult(
      { content: [], details: undefined },
      { expanded: false, isPartial: true },
    );
    expect(partial).toContain("Run workspace task…");

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
      { expanded: false, isPartial: true },
    );
    expect(streaming).toContain("[running] npm test");
    expect(streaming).toContain("test output");
    expect(streaming).toContain("[done (0)] git status");
    expect(streaming).toContain("[running] sleep 1");

    const symbolResult = renderToolResult(
      { content: [], details: { value: Symbol("value"), truncated: false } },
      { expanded: false, isPartial: false },
    );
    expect(symbolResult).toContain("Symbol(value)");

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const circularResult = renderToolResult(
      { content: [], details: { value: circular, truncated: false } },
      { expanded: false, isPartial: false },
    );
    expect(circularResult).toContain("[object Object]");

    const error = renderToolResult(
      { content: [{ type: "text", text: "bad code" }] },
      { expanded: false, isPartial: false },
      { isError: true, args: { label: "Compile renderer", code: "" } },
    );
    expect(error).toContain("bad code");
    expect(error).toContain("Failed: Compile renderer");
    expect(
      renderToolResult({ content: [] }, { expanded: false, isPartial: false }, { isError: true }),
    ).toContain("TypeScript execution failed");
  });
});
