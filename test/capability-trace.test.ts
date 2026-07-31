import { describe, expect, it } from "vitest";
import {
  CapabilityTraceCollector,
  finishCapabilityTrace,
  startCapabilityTrace,
} from "../src/capability-trace.js";

describe("capability traces", () => {
  it("summarizes arguments without retaining values", () => {
    const trace = startCapabilityTrace(
      7,
      3,
      "capability".repeat(20),
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
    expect(trace.capability).toHaveLength(80);
    expect(trace.method).toHaveLength(80);
    expect(JSON.stringify(trace)).not.toContain("secret-token");
    expect(JSON.stringify(trace)).not.toContain("password");
  });

  it("finishes traces with nonnegative durations and outcomes", () => {
    const started = startCapabilityTrace(1, 1, "git", "status", [], 200);
    expect(finishCapabilityTrace(started, "succeeded", 250)).toMatchObject({
      durationMs: 50,
      status: "succeeded",
    });
    expect(finishCapabilityTrace(started, "failed", 150)).toMatchObject({
      durationMs: 0,
      status: "failed",
    });
  });

  it("updates retained traces, preserves sequence order, and reports truncation", () => {
    const collector = new CapabilityTraceCollector(2);
    const second = startCapabilityTrace(2, 2, "git", "diff", [], 20);
    const first = startCapabilityTrace(1, 1, "git", "status", [], 10);
    collector.record(second);
    collector.record(first);
    collector.record(finishCapabilityTrace(first, "succeeded", 15));
    collector.record(startCapabilityTrace(3, 3, "git", "log", [], 30));

    expect(collector.snapshot()).toMatchObject({
      truncated: true,
      traces: [
        { sequence: 1, status: "succeeded", durationMs: 5 },
        { sequence: 2, status: "running" },
      ],
    });
  });
});
