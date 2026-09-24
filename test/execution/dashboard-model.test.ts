import { describe, expect, it } from "vitest";

import { buildExecutionDashboardModel } from "../../src/execution/dashboard-model.js";

const functionContext = {
  invocationId: 1,
  name: "waitForRun",
  scope: "project" as const,
  depth: 1,
};

describe("execution dashboard model", () => {
  it("returns an empty model without execution details", () => {
    expect(buildExecutionDashboardModel(undefined, 1_000)).toEqual({
      activities: [],
      events: [],
      tracesTruncated: false,
    });
  });

  it("groups repeated calls and preserves unattributed activities", () => {
    const model = buildExecutionDashboardModel(
      {
        functions: [
          { action: "run", name: "waitForRun", scope: "project" },
          { action: "run", name: "unattributed", scope: "session" },
        ],
        traces: [
          {
            id: 1,
            sequence: 1,
            capability: "__pit",
            method: "savedFunctionRun",
            arguments: [],
            startedAt: 0,
            durationMs: 1,
            status: "succeeded",
            function: functionContext,
          },
          ...[2, 3].map((sequence) => ({
            id: sequence,
            sequence,
            capability: "gh",
            method: "runView",
            arguments: [],
            startedAt: sequence === 2 ? 1_000 : 6_000,
            durationMs: 100,
            status: "succeeded" as const,
            function: functionContext,
          })),
          {
            id: 4,
            sequence: 4,
            capability: "gh",
            method: "runView",
            arguments: [],
            startedAt: 11_000,
            status: "running",
            function: functionContext,
          },
        ],
        tracesTruncated: true,
      },
      12_000,
    );
    expect(model.activities).toEqual([{ scope: "session", name: "unattributed" }]);
    expect(model.tracesTruncated).toBe(true);
    expect(model.events).toEqual([
      {
        kind: "function",
        id: 1,
        scope: "project",
        name: "waitForRun",
        events: [
          {
            kind: "call",
            sequences: [2, 3, 4],
            capability: "gh",
            method: "runView",
            status: "running",
            count: 3,
            statuses: [
              { status: "succeeded", count: 2 },
              { status: "running", count: 1 },
            ],
            durationMs: 11_000,
            unfinished: true,
          },
        ],
      },
    ]);
  });

  it("keeps failed calls separate and nests child invocations in sequence order", () => {
    const child = {
      invocationId: 2,
      parentInvocationId: 1,
      name: "child",
      scope: "session" as const,
      depth: 2,
    };
    const model = buildExecutionDashboardModel(
      {
        traces: [
          {
            id: 1,
            sequence: 1,
            capability: "context",
            method: "get",
            arguments: [],
            startedAt: 0,
            durationMs: 10,
            status: "failed",
            function: functionContext,
          },
          {
            id: 2,
            sequence: 2,
            capability: "__pit",
            method: "savedFunctionRun",
            arguments: [],
            startedAt: 20,
            durationMs: 1,
            status: "succeeded",
            function: child,
          },
          {
            id: 3,
            sequence: 3,
            capability: "shell",
            method: "execFile",
            arguments: [],
            startedAt: 30,
            durationMs: 20,
            status: "rejected",
            function: child,
          },
        ],
      },
      100,
    );
    expect(model.events[0]).toMatchObject({
      kind: "function",
      name: "waitForRun",
      events: [
        { kind: "call", status: "failed", count: 1, durationMs: 10, unfinished: false },
        {
          kind: "function",
          name: "child",
          events: [
            { kind: "call", status: "rejected", count: 1, durationMs: 20, unfinished: false },
          ],
        },
      ],
    });
  });
});
