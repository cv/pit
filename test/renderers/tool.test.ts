import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cleanupHarness, renderToolResult, setupHarness } from "../support/extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

describe("tool rendering", () => {
  it("renders semantic warnings and unusual values", () => {
    const warningResult = renderToolResult(
      {
        content: [],
        details: {
          value: {
            stdout: JSON.stringify({ pit: { current: "1", latest: "2" } }),
            stderr: "",
            code: 1,
            truncated: false,
          },
          truncated: false,
        },
      },
      { expanded: false, isPartial: false },
      { args: { code: "async ({ npm }) => npm.outdated()" } },
    );
    expect(warningResult).toContain("⚠ npm outdated, 1 package");

    const symbolResult = renderToolResult(
      { content: [], details: { value: Symbol("value"), truncated: false } },
      { expanded: false, isPartial: false },
    );
    expect(symbolResult).toContain("Returned symbol (1 line, 0.0s)");
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
    expect(circularResult).toContain("Returned 1 field: self (1 line, 0.0s)");
    expect(circularResult).not.toContain("[object Object]");
    const expandedCircular = renderToolResult(
      { content: [], details: { value: circular, truncated: false } },
      { expanded: true, isPartial: false },
    );
    expect(stripTerminalSequences(expandedCircular)).toContain("[object Object]");
  });

  it("renders concise and bounded failures", () => {
    const error = renderToolResult(
      { content: [{ type: "text", text: "bad code" }] },
      { expanded: false, isPartial: false },
      { isError: true, args: { label: "Compile renderer", code: "" } },
    );
    expect(error).toContain("bad code");
    expect(error).toContain("✗ Failed (0.0s)");
    expect(error).not.toContain("Compile renderer");
    expect(error.split("\n")[0]).toContain("✗ Failed");
    const expandedError = renderToolResult(
      { content: [{ type: "text", text: "bad code" }] },
      { expanded: true, isPartial: false },
      { isError: true, args: { label: "Compile renderer", code: "" } },
    );
    expect(expandedError.split("\n")[0]?.trim()).toBe("");
    expect(expandedError.split("\n")[1]).toContain("✗ Failed");
    expect(expandedError).not.toContain("Compile renderer");

    const structuredError = renderToolResult(
      {
        content: [{ type: "text", text: "wrapped" }],
        details: {
          value: undefined,
          truncated: false,
          failure: {
            functionPath: ["outer", "inner"],
            rootError: "boom",
            kind: "user",
          },
          traces: [],
          functions: [{ action: "run", name: "outer", scope: "session" }],
        },
      },
      { expanded: true, isPartial: false },
      { isError: true, args: { code: "outer()" } },
    );
    expect(structuredError).toContain("Function path");
    expect(structuredError).toContain("outer → inner");
    expect(structuredError).toContain("Execution");
    expect(structuredError).toContain("boom");
    expect(structuredError).not.toContain("wrapped");

    const longFailure = Array.from({ length: 20 }, (_, index) => `failure line ${index}`).join(
      "\n",
    );
    const longPath = Array.from({ length: 12 }, (_, index) => `function${index}`);
    const compactFailure = renderToolResult(
      {
        content: [{ type: "text", text: longFailure }],
        details: {
          value: undefined,
          truncated: false,
          failure: { functionPath: longPath, rootError: longFailure, kind: "user" },
        },
      },
      { expanded: false, isPartial: false },
      { isError: true },
    );
    expect(compactFailure).toContain("failure line 0 …");
    expect(compactFailure).not.toContain("failure line 1");

    const expandedFailure = renderToolResult(
      {
        content: [{ type: "text", text: longFailure }],
        details: {
          value: undefined,
          truncated: false,
          failure: { functionPath: longPath, rootError: longFailure, kind: "user" },
        },
      },
      { expanded: true, isPartial: false },
      { isError: true },
    );
    expect(expandedFailure).toContain("function0 → function1 → function2 → function3");
    expect(expandedFailure).toContain("… 4 omitted");
    expect(expandedFailure).toContain("function8 → function9 → function10 → function11");
    expect(expandedFailure).toContain("failure line 11");
    expect(expandedFailure).not.toContain("failure line 12");
    expect(expandedFailure).toContain("additional diagnostic lines omitted");

    expect(
      renderToolResult({ content: [] }, { expanded: false, isPartial: false }, { isError: true }),
    ).toContain("TypeScript execution failed");
  });

  it("uses runtime traces for saved-function results and falls back when attribution is ambiguous", () => {
    const value = { stdout: "## main\n", stderr: "", code: 0, truncated: false };
    const trace = (sequence: number, capability: string, method: string) => ({
      id: sequence,
      sequence,
      capability,
      method,
      arguments: [],
      startedAt: 1,
      durationMs: 2,
      status: "succeeded",
    });

    const attributed = renderToolResult(
      {
        content: [],
        details: {
          value,
          truncated: false,
          traces: [trace(1, "__pit", "savedFunctionRun"), trace(2, "git", "status")],
        },
      },
      { expanded: false, isPartial: false },
      { args: { code: "runStatus()" } },
    );
    expect(attributed).toContain("Git status, main, clean");

    const ambiguous = renderToolResult(
      {
        content: [],
        details: {
          value,
          truncated: false,
          traces: [trace(1, "git", "status"), trace(2, "git", "diff")],
        },
      },
      { expanded: false, isPartial: false },
      { args: { code: "runMany()" } },
    );
    expect(ambiguous).toContain("Command exit 0");
  });
});
