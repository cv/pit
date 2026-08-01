import { describe, expect, it, vi } from "vitest";
import { finishCapabilityTrace, startCapabilityTrace } from "../src/capability-trace.js";
import { ExecutionProgressController } from "../src/execution-progress.js";

describe("ExecutionProgressController", () => {
  it("emits updates for every trace transition", () => {
    const update = vi.fn();
    const c = new ExecutionProgressController(update);
    const start = startCapabilityTrace(1, 1, "git", "status", [], 10);
    c.recordTrace(start);
    c.recordTrace(finishCapabilityTrace(start, "succeeded", 15));
    expect(update).toHaveBeenCalledTimes(2);
    expect(c.details().traces?.[0]).toMatchObject({ status: "succeeded", durationMs: 5 });
  });
  it("combines bounded shell tails with trace details", () => {
    const update = vi.fn();
    const c = new ExecutionProgressController(update);
    c.recordShell({ id: 1, command: "git status", phase: "start" });
    c.recordShell({ id: 1, command: "git status", phase: "output", stream: "stdout", chunk: "ok" });
    c.recordShell({ id: 1, command: "git status", phase: "end", code: 0 });
    expect(c.details().progress?.[0]).toMatchObject({ status: "done", code: 0, output: "ok" });
    expect(update).toHaveBeenCalled();
  });
  it("works without a partial update callback", () => {
    const c = new ExecutionProgressController();
    c.recordTrace(startCapabilityTrace(1, 1, "context", "get", []));
    expect(c.details().traces).toHaveLength(1);
  });
});
