import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { finishCapabilityTrace, startCapabilityTrace } from "../src/capability-trace.js";
import { ExecutionProgressController } from "../src/execution-progress.js";

afterEach(() => vi.useRealTimers());

describe("ExecutionProgressController", () => {
  it("emits immediately and coalesces burst transitions for 200 ms", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const listener = vi.fn();
    const c = new ExecutionProgressController(listener);
    const start = startCapabilityTrace(1, 1, "git", "status", [], 10);

    c.recordTrace(start);
    vi.advanceTimersByTime(20);
    c.recordTrace(finishCapabilityTrace(start, "succeeded", 15));
    c.recordTrace(startCapabilityTrace(2, 2, "context", "get", []));
    expect(listener).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(179);
    expect(listener).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[1]?.[0].traces?.[0]).toMatchObject({
      status: "succeeded",
      durationMs: 5,
    });
    vi.advanceTimersByTime(201);
    c.recordTrace(startCapabilityTrace(3, 3, "git", "diff", []));
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("flushes a pending final snapshot synchronously", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const listener = vi.fn();
    const c = new ExecutionProgressController(listener);
    const start = startCapabilityTrace(1, 1, "npm", "test", []);
    c.recordTrace(start);
    c.recordTrace(finishCapabilityTrace(start, "failed"));
    c.flush();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[1]?.[0].traces?.[0]?.status).toBe("failed");
    vi.runAllTimers();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("cancels pending work and suppresses callbacks after disposal", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const listener = vi.fn();
    const c = new ExecutionProgressController(listener);
    c.recordTrace(startCapabilityTrace(1, 1, "git", "status", []));
    c.recordTrace(startCapabilityTrace(2, 2, "npm", "test", []));
    c.dispose();
    c.flush();
    c.recordTrace(startCapabilityTrace(3, 3, "context", "get", []));
    vi.runAllTimers();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(c.snapshot().traces).toHaveLength(3);
  });

  it("retains all running shell calls and only 32 completed calls in source order", () => {
    const c = new ExecutionProgressController();
    c.recordShell({ id: 1, command: "still running", phase: "start" });
    for (let id = 2; id <= 34; id++) {
      c.recordShell({ id, command: `command ${id}`, phase: "start" });
      c.recordShell({ id, command: `command ${id}`, phase: "end", code: 0 });
    }
    const snapshot = c.snapshot();
    expect(snapshot.progressTruncated).toBe(true);
    expect(snapshot.progress).toHaveLength(33);
    expect(snapshot.progress?.map((entry) => entry.id)).toEqual([
      1,
      ...Array.from({ length: 32 }, (_, index) => index + 3),
    ]);
    expect(snapshot.progress?.[0]?.status).toBe("running");
  });

  it("combines bounded shell tails with stable snapshots", () => {
    const listener = vi.fn();
    const c = new ExecutionProgressController(listener);
    c.recordShell({ id: 1, command: "git status", phase: "start" });
    const earlier = c.snapshot();
    c.recordShell({ id: 1, command: "git status", phase: "output", stream: "stdout", chunk: "ok" });
    c.recordShell({ id: 1, command: "git status", phase: "end", code: 0 });
    expect(earlier.progress?.[0]).toEqual({
      id: 1,
      command: "git status",
      status: "running",
      output: "",
    });
    expect(c.snapshot().progress?.[0]).toMatchObject({ status: "done", code: 0, output: "ok" });
  });

  it("does not depend on TUI renderer modules", () => {
    for (const file of ["execution-progress.ts", "execution-types.ts"]) {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
      expect(source).not.toMatch(/from ["'][^"']*renderer/);
    }
  });

  it("records snapshots without a listener", () => {
    const c = new ExecutionProgressController();
    c.recordTrace(startCapabilityTrace(1, 1, "context", "get", []));
    c.flush();
    expect(c.snapshot().traces).toHaveLength(1);
  });
});
