import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { finishCapabilityTrace, startCapabilityTrace } from "../src/capability-trace.js";
import { ExecutionProgressController } from "../src/execution-progress.js";

describe("ExecutionProgressController", () => {
  it("emits snapshots for every trace transition", () => {
    const listener = vi.fn();
    const c = new ExecutionProgressController(listener);
    const start = startCapabilityTrace(1, 1, "git", "status", [], 10);
    c.recordTrace(start);
    c.recordTrace(finishCapabilityTrace(start, "succeeded", 15));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[0]?.[0]).toEqual({ traces: [start] });
    expect(c.snapshot().traces?.[0]).toMatchObject({ status: "succeeded", durationMs: 5 });
  });

  it("combines bounded shell tails with trace details", () => {
    const listener = vi.fn();
    const c = new ExecutionProgressController(listener);
    c.recordShell({ id: 1, command: "git status", phase: "start" });
    c.recordShell({ id: 1, command: "git status", phase: "output", stream: "stdout", chunk: "ok" });
    c.recordShell({ id: 1, command: "git status", phase: "end", code: 0 });
    expect(c.snapshot().progress?.[0]).toMatchObject({ status: "done", code: 0, output: "ok" });
    expect(listener).toHaveBeenCalled();
  });

  it("returns shell snapshots that remain stable after later events", () => {
    const c = new ExecutionProgressController();
    c.recordShell({ id: 1, command: "git status", phase: "start" });
    const earlier = c.snapshot();
    c.recordShell({ id: 1, command: "git status", phase: "end", code: 0 });
    expect(earlier.progress?.[0]).toEqual({
      id: 1,
      command: "git status",
      status: "running",
      output: "",
    });
    expect(c.snapshot().progress?.[0]?.status).toBe("done");
  });

  it("does not depend on TUI renderer modules", () => {
    for (const file of ["execution-progress.ts", "execution-types.ts"]) {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
      expect(source).not.toMatch(/from ["'][^"']*renderer/);
    }
  });

  it("works without a snapshot listener", () => {
    const c = new ExecutionProgressController();
    c.recordTrace(startCapabilityTrace(1, 1, "context", "get", []));
    expect(c.snapshot().traces).toHaveLength(1);
  });
});
