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
    expect(collapsedLines).toHaveLength(1);
    expect(collapsed).not.toContain("source line 1");
    expect(collapsed).not.toContain("more lines");

    const expanded = renderToolCall({ code }, { expanded: true, argsComplete: true });
    expect(expanded).toContain("Run workspace task (15 lines, 0.0s)");
    expect(expanded).toContain("source line 15");
    expect(expanded).not.toContain("more lines");
    expect(expanded.split("\n")[1]).toContain("source line 1");

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
    expect(expandedEmpty.split("\n")[1]).toContain("empty source");

    const partial = renderToolCall({ code: undefined }, { expanded: false, argsComplete: false });
    expect(partial).toContain("generating... 0.0s");
    expect(partial).not.toContain("waiting for source…");
    expect(partial).toContain("⠋ ");
    const inferred = renderToolCall(
      {
        label: "  \n ",
        code: 'async ({ workspace }) => workspace.read("README.md")',
      },
      { expanded: false, argsComplete: true },
    );
    expect(inferred).toContain("Read workspace files");

    const git = renderToolCall(
      { code: 'async ({ git }) => git.status(["--short"])' },
      { expanded: false, argsComplete: true },
    );
    expect(git).toContain("Inspect Git status");

    const named = renderToolCall(
      { code: "async function buildProject() { return true; }" },
      { expanded: false, argsComplete: true },
    );
    expect(named).toContain("Define and run buildProject");

    const waiting = renderToolCall({ code: undefined }, { expanded: true, argsComplete: false });
    expect(waiting).toContain("waiting for source…");
    expect(waiting.split("\n")[1]).toContain("waiting for source…");
  });

  it("keeps hidden call and result descriptions on adjacent lines", () => {
    const call = renderToolCall(
      { label: "Render generated TypeScript", code: "return value" },
      { expanded: false, argsComplete: true },
    );
    const result = renderToolResult(
      { content: [], details: { value: { value: true }, truncated: false } },
      { expanded: false, isPartial: false },
    );

    expect(`${call}\n${result}`.split("\n")).toHaveLength(2);
  });

  it("animates generation every 200ms and freezes timing when generation completes", () => {
    vi.useFakeTimers();
    try {
      const state = {};
      const invalidate = vi.fn();
      const context = { expanded: false, argsComplete: false, state, invalidate };

      expect(renderToolCall({ code: undefined }, context)).toContain(
        "⠋ Run workspace task (generating... 0.0s)",
      );
      vi.advanceTimersByTime(400);
      expect(invalidate).toHaveBeenCalledTimes(2);
      expect(renderToolCall({ code: undefined }, context)).toContain(
        "⠹ Run workspace task (generating... 0.4s)",
      );

      const completed = renderToolCall({ code: "return 1" }, { ...context, isPartial: false });
      expect(completed).toContain("1 line, 0.4s");
      vi.advanceTimersByTime(400);
      expect(invalidate).toHaveBeenCalledTimes(2);
      const executionStarted = renderToolCall(
        { code: "return 1" },
        { expanded: false, argsComplete: false, executionStarted: true, state: {} },
      );
      expect(executionStarted).toContain("1 line, 0.0s");
    } finally {
      vi.useRealTimers();
    }
  });

  it("animates execution every 200ms and freezes timing on the final result", () => {
    vi.useFakeTimers();
    try {
      const state = {};
      const invalidate = vi.fn();
      const context = { state, invalidate, args: { label: "Run command", code: "" } };
      const partialResult = { content: [], details: undefined };

      const started = renderToolResult(
        partialResult,
        { expanded: false, isPartial: true },
        context,
      );
      expect(started).toContain("⠋ Running... (0.0s)");
      expect(started).not.toContain("Run command");
      vi.advanceTimersByTime(400);
      expect(invalidate).toHaveBeenCalledTimes(2);
      expect(
        renderToolResult(partialResult, { expanded: false, isPartial: true }, context),
      ).toContain("⠹ Running... (0.4s)");

      const completed = renderToolResult(
        partialResult,
        { expanded: false, isPartial: false },
        context,
      );
      expect(completed).toContain("No returned value (0 lines, 0.4s)");
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
    expect(collapsed).toContain("Returned 15 fields: key1, key2, key3 (17 lines, 0.0s)");
    const resultLines = collapsed.split("\n");
    expect(resultLines).toHaveLength(1);
    expect(resultLines[0]).toContain("\u001b[1m");
    expect(resultLines[0]).toContain("✓ ");
    expect(collapsed).not.toContain('"key1"');
    expect(collapsed).not.toContain("more lines");

    const expanded = renderToolResult(result, { expanded: true, isPartial: false });
    expect(expanded).toContain('"key15"');
    expect(expanded).not.toContain("more lines");

    const stringResult = renderToolResult(
      { content: [{ type: "text", text: "hello" }], details: { value: "hello", truncated: false } },
      { expanded: false, isPartial: false },
    );
    expect(stringResult).toContain("Returned string (1 line, 0.0s)");
    expect(stringResult).not.toContain('"hello"');
    const arrayResult = renderToolResult(
      { content: [], details: { value: [1, 2], truncated: false } },
      { expanded: false, isPartial: false },
    );
    expect(arrayResult).toContain("Returned 2 items (4 lines, 0.0s)");

    const singleArrayResult = renderToolResult(
      { content: [], details: { value: [1], truncated: false } },
      { expanded: false, isPartial: false },
    );
    expect(singleArrayResult).toContain("Returned 1 item");

    const emptyObjectResult = renderToolResult(
      { content: [], details: { value: {}, truncated: false } },
      { expanded: false, isPartial: false },
    );
    expect(emptyObjectResult).toContain("Returned 0 fields (1 line, 0.0s)");

    const undefinedResult = renderToolResult(
      {
        content: [{ type: "text", text: "undefined" }],
        details: { value: undefined, truncated: false },
      },
      { expanded: false, isPartial: false },
    );
    expect(undefinedResult).toContain("Returned text (1 line, 0.0s)");
    expect(undefinedResult).not.toContain("undefined");

    const truncated = renderToolResult(
      {
        content: [{ type: "text", text: "partial output" }],
        details: { value: undefined, truncated: true },
      },
      { expanded: false, isPartial: false },
    );
    expect(truncated).toContain("Truncated output (truncated, 0.0s)");
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
    expect(empty).toContain("No returned value (0 lines, 0.0s)");

    const emptyText = renderToolResult(
      { content: [{ type: "text" }], details: undefined },
      { expanded: false, isPartial: false },
    );
    expect(emptyText).toContain("No returned value");
    const expandedEmptyResult = renderToolResult(
      { content: [], details: undefined },
      { expanded: true, isPartial: false },
    );
    expect(expandedEmptyResult).toContain("(no result)");

    const partial = renderToolResult(
      { content: [], details: undefined },
      { expanded: true, isPartial: true },
    );
    expect(partial).toContain("⠋ Running... (0.0s)");
  });

  it("renders live shell and capability progress", () => {
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
          progressTruncated: true,
          functions: [
            { action: "run", name: "projectChecks", scope: "project" },
            { action: "run", name: "sessionChecks" },
          ],
          traces: [
            {
              id: 1,
              sequence: 1,
              capability: "npm",
              method: "test",
              arguments: [],
              startedAt: Date.now(),
              status: "running",
              function: {
                invocationId: 1,
                name: "projectChecks",
                scope: "project",
                depth: 1,
              },
            },
            {
              id: 2,
              sequence: 2,
              capability: "git",
              method: "status",
              arguments: [],
              startedAt: 1,
              durationMs: 5,
              status: "succeeded",
            },
          ],
          tracesTruncated: true,
        },
      },
      { expanded: true, isPartial: true },
    );
    expect(streaming).toContain("[running] npm test");
    expect(streaming).toContain("earlier shell calls omitted");
    expect(streaming).toContain("test output");
    expect(streaming).toContain("[done (0)] git status");
    expect(streaming).toContain("[running] sleep 1");
    expect(streaming).toContain("project function projectChecks");
    expect(streaming).toContain("session function sessionChecks");
    expect(streaming).toContain("npm.test");
    expect(streaming).toContain("project function projectChecks #1");
    expect(streaming.match(/project function projectChecks/g)).toHaveLength(1);
    expect(streaming).toContain("running");
    expect(streaming).toContain("git.status");
    expect(streaming).toContain("succeeded");
    expect(streaming).toContain("additional capability traces omitted");
  });

  it("aggregates repeated polling and preserves failures", () => {
    const now = Date.now();
    const polling = renderToolResult(
      {
        content: [{ type: "text", text: "Running TypeScript…" }],
        details: {
          value: undefined,
          truncated: false,
          traces: Array.from({ length: 30 }, (_, index) => ({
            id: index + 1,
            sequence: index + 1,
            capability: "gh",
            method: "runView",
            arguments: [],
            startedAt: now - (29 - index) * 5000,
            ...(index < 29 ? { durationMs: 100 } : {}),
            status: index < 29 ? ("succeeded" as const) : ("running" as const),
            function: {
              invocationId: 1,
              name: "waitForGitHubRun",
              scope: "project" as const,
              depth: 1,
            },
          })),
          progress: Array.from({ length: 30 }, (_, index) => ({
            id: index + 1,
            command: "gh run view 42",
            status: index < 29 ? ("done" as const) : ("running" as const),
            ...(index < 29 ? { code: 0 } : {}),
            output: index < 29 ? `poll output ${index + 1}` : "",
          })),
        },
      },
      { expanded: true, isPartial: true },
    );
    expect(polling.match(/gh\.runView/g)).toHaveLength(1);
    expect(polling).toContain("29 succeeded, 1 running over");
    expect(polling).toContain("[running, 29 done (0)] gh run view 42");
    expect(polling).not.toContain("poll output");

    const completedPolling = renderToolResult(
      {
        content: [{ type: "text", text: "Running TypeScript…" }],
        details: {
          value: undefined,
          truncated: false,
          traces: [1, 2].map((id) => ({
            id,
            sequence: id,
            capability: "gh",
            method: "runView",
            arguments: [],
            startedAt: id * 1000,
            durationMs: 100,
            status: "succeeded" as const,
          })),
          progress: [1, 2].map((id) => ({
            id,
            command: "gh run view 42",
            status: "done" as const,
            code: 0,
            output: `completed output ${id}`,
          })),
        },
      },
      { expanded: true, isPartial: true },
    );
    expect(completedPolling).toContain("gh.runView");
    expect(completedPolling).toContain("succeeded ×2 over");
    expect(completedPolling).toContain("[2 done (0)] gh run view 42");
    expect(completedPolling).not.toContain("completed output");

    const visibleFailures = renderToolResult(
      {
        content: [{ type: "text", text: "Running TypeScript…" }],
        details: {
          value: undefined,
          truncated: false,
          traces: ["failed", "rejected"].map((status, index) => ({
            id: index + 1,
            sequence: index + 1,
            capability: "gh",
            method: "runView",
            arguments: [],
            startedAt: index,
            durationMs: 1,
            status: status as "failed" | "rejected",
          })),
          progress: [
            {
              id: 1,
              command: "gh run view 42",
              status: "done" as const,
              code: 1,
              output: "API failed",
            },
            { id: 2, command: "watch", status: "running" as const, output: "earlier" },
            { id: 3, command: "watch", status: "running" as const, output: "latest" },
          ],
        },
      },
      { expanded: true, isPartial: true },
    );
    expect(visibleFailures.match(/gh\.runView/g)).toHaveLength(2);
    expect(visibleFailures).toContain("failed");
    expect(visibleFailures).toContain("rejected");
    expect(visibleFailures).toContain("[done (1)] gh run view 42");
    expect(visibleFailures).toContain("API failed");
    expect(visibleFailures).toContain("[2 running] watch");
    expect(visibleFailures).toContain("latest");
  });

  it("renders nested final execution dashboards", () => {
    const finalDashboard = renderToolResult(
      {
        content: [{ type: "text", text: "done" }],
        details: {
          value: { done: true },
          truncated: false,
          traces: [
            {
              id: 1,
              sequence: 1,
              capability: "__pit",
              method: "savedFunctionRun",
              arguments: [],
              startedAt: 1,
              durationMs: 1,
              status: "succeeded",
              function: {
                invocationId: 1,
                name: "outer",
                scope: "session",
                depth: 1,
              },
            },
            {
              id: 2,
              sequence: 2,
              capability: "__pit",
              method: "savedFunctionRun",
              arguments: [],
              startedAt: 2,
              durationMs: 1,
              status: "succeeded",
              function: {
                invocationId: 2,
                parentInvocationId: 1,
                name: "child",
                scope: "session",
                depth: 2,
              },
            },
            {
              id: 3,
              sequence: 3,
              capability: "context",
              method: "get",
              arguments: [],
              startedAt: 3,
              durationMs: 1,
              status: "succeeded",
            },
            {
              id: 4,
              sequence: 4,
              capability: "shell",
              method: "execFile",
              arguments: [],
              startedAt: 4,
              durationMs: 10,
              status: "succeeded",
              function: {
                invocationId: 2,
                parentInvocationId: 1,
                name: "child",
                scope: "session",
                depth: 2,
              },
            },
          ],
        },
      },
      { expanded: true, isPartial: false },
    );
    expect(finalDashboard).toContain("Execution");
    const outerIndex = finalDashboard.indexOf("session function outer #1");
    const childIndex = finalDashboard.indexOf("session function child #2");
    const shellIndex = finalDashboard.indexOf("shell.execFile");
    expect(outerIndex).toBeGreaterThan(-1);
    expect(childIndex).toBeGreaterThan(outerIndex);
    expect(shellIndex).toBeGreaterThan(childIndex);
  });

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
    expect(expandedCircular).toContain("[object Object]");
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
