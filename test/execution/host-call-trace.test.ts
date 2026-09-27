import { describe, expect, it } from "vitest";

import {
  HostCallTraceCollector,
  startHostCallTrace as createHostCallTrace,
  type FunctionExecutionContext,
  finishHostCallTrace,
} from "../../src/execution/host-call-trace.js";

function startHostCallTrace(
  id: number,
  sequence: number,
  namespace: string,
  method: string,
  args: unknown[],
  startedAt?: number,
  functionContext?: FunctionExecutionContext,
) {
  return createHostCallTrace({
    id,
    sequence,
    namespace,
    method,
    args,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(functionContext ? { functionContext } : {}),
  });
}

describe("host-call traces", () => {
  it("summarizes arguments without retaining values", () => {
    const trace = startHostCallTrace(
      7,
      3,
      "namespace".repeat(20),
      "method".repeat(20),
      [
        null,
        "secret-token",
        42,
        true,
        ["private", "values"],
        { password: "hidden", token: "hidden" },
        undefined,
        false,
        "omitted",
      ],
      100,
      {
        invocationId: 11,
        parentInvocationId: 9,
        name: "function".repeat(20),
        scope: "project",
        depth: 2,
      },
    );

    expect(trace).toMatchObject({
      id: 7,
      sequence: 3,
      startedAt: 100,
      status: "running",
      argumentsTruncated: true,
      arguments: [
        { type: "null" },
        { type: "string", size: 12 },
        { type: "number" },
        { type: "boolean" },
        { type: "array", size: 2 },
        { type: "object", size: 2 },
        { type: "other" },
        { type: "boolean" },
      ],
    });
    expect(trace.namespace).toHaveLength(80);
    expect(trace.method).toHaveLength(80);
    expect(trace.function).toMatchObject({
      invocationId: 11,
      parentInvocationId: 9,
      scope: "project",
      depth: 2,
    });
    expect(trace.function?.name).toHaveLength(80);
    expect(JSON.stringify(trace)).not.toContain("secret-token");
    expect(JSON.stringify(trace)).not.toContain("password");
  });

  it("finishes traces with nonnegative durations and outcomes", () => {
    const started = startHostCallTrace(1, 1, "git", "status", [], 200);
    expect(finishHostCallTrace(started, "succeeded", 250)).toMatchObject({
      durationMs: 50,
      status: "succeeded",
    });
    expect(finishHostCallTrace(started, "failed", 150)).toMatchObject({
      durationMs: 0,
      status: "failed",
    });
  });

  it("updates retained traces, preserves sequence order, and reports truncation", () => {
    const collector = new HostCallTraceCollector(2);
    const second = startHostCallTrace(2, 2, "git", "diff", [], 20);
    const first = startHostCallTrace(1, 1, "git", "status", [], 10);
    collector.record(second);
    collector.record(first);
    collector.record(finishHostCallTrace(first, "succeeded", 15));
    collector.record(startHostCallTrace(3, 3, "git", "log", [], 30));

    expect(collector.snapshot()).toMatchObject({
      truncated: true,
      traces: [
        { sequence: 1, status: "succeeded", durationMs: 5 },
        { sequence: 2, status: "running" },
      ],
    });
  });
});
