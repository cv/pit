import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fitValue } from "../../src/shared/json-budget.js";
import { cleanupHarness, renderToolResult, setupHarness } from "../support/extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

describe("tool rendering", () => {
  it("renders fitted truncated results through their domain view", () => {
    const stdout = Array.from({ length: 3_000 }, (_, index) => `line ${index} end`).join("\n");
    const fitted = fitValue(
      { stdout, stderr: "boom", code: 0, truncated: false },
      { maxBytes: 20_000, maxLines: 2_000 },
    );
    const result = {
      content: [{ type: "text", text: fitted.text }],
      details: { value: fitted.value, truncated: fitted.truncated },
    };

    const collapsed = renderToolResult(result, { expanded: false, isPartial: false });
    expect(collapsed).toContain("exit 0, truncated");
    expect(collapsed).toContain("(truncated, 0.0s)");
    expect(collapsed).toContain("⚠");
    expect(collapsed).not.toContain("Truncated output");

    const expanded = renderToolResult(result, { expanded: true, isPartial: false });
    expect(expanded).toContain("line 0 end");
    expect(expanded).toContain("line 2999 end");
    expect(expanded).toMatch(/… \d+ lines omitted …/);
    expect(expanded).toContain("boom");
    expect(expanded).toContain("Result truncated to fit the output budget");
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
    expect(collapsed).toContain("Returned 15 fields: key1, key2, key3 (0.0s)");
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
    expect(stringResult).toContain('Returned string: "hello" (0.0s)');
    const arrayResult = renderToolResult(
      { content: [], details: { value: [1, 2], truncated: false } },
      { expanded: false, isPartial: false },
    );
    expect(arrayResult).toContain("Returned 2 items (0.0s)");

    const singleArrayResult = renderToolResult(
      { content: [], details: { value: [1], truncated: false } },
      { expanded: false, isPartial: false },
    );
    expect(singleArrayResult).toContain("Returned 1 item");

    const emptyObjectResult = renderToolResult(
      { content: [], details: { value: {}, truncated: false } },
      { expanded: false, isPartial: false },
    );
    expect(emptyObjectResult).toContain("Returned 0 fields (0.0s)");

    const undefinedResult = renderToolResult(
      {
        content: [{ type: "text", text: "undefined" }],
        details: { value: undefined, truncated: false },
      },
      { expanded: false, isPartial: false },
    );
    expect(undefinedResult).toContain("No returned value (0.0s)");
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
    expect(empty).toContain("No returned value (0.0s)");

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
    expect(streaming).toContain("earlier shell calls were not retained");
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
    expect(streaming).toContain("completed");
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
    expect(polling).toContain("29 completed, 1 running over");
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
    expect(completedPolling).toContain("completed ×2 over");
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
});
