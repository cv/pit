import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startCapabilityTrace as createCapabilityTrace,
  finishCapabilityTrace,
} from "../../src/execution/capability-trace.js";
import { ExecutionProgressController } from "../../src/execution/progress.js";

function startCapabilityTrace(
  id: number,
  sequence: number,
  capability: string,
  method: string,
  args: unknown[],
  startedAt?: number,
) {
  return createCapabilityTrace({
    id,
    sequence,
    capability,
    method,
    args,
    ...(startedAt === undefined ? {} : { startedAt }),
  });
}

afterEach(() => vi.useRealTimers());

describe("ExecutionProgressController", () => {
  it("emits immediately and coalesces burst transitions for 200 ms", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
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
    vi.setSystemTime(1000);
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
    vi.setSystemTime(1000);
    const listener = vi.fn();
    const c = new ExecutionProgressController(listener);
    c.recordTrace(startCapabilityTrace(1, 1, "git", "status", []));
    c.recordTrace(startCapabilityTrace(2, 2, "npm", "test", []));
    c.dispose();
    c.flush();
    c.recordTrace(startCapabilityTrace(3, 3, "context", "get", []));
    c.recordShell({ id: 1, command: "late", phase: "start" });
    vi.runAllTimers();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(c.snapshot().traces).toHaveLength(2);
    expect(c.snapshot().progress).toBeUndefined();
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
    c.recordShell({
      id: 1,
      command: "git status",
      phase: "output",
      stream: "stdout",
      chunk: "\u001b[32mok\u001b[0m\u001b[2J",
    });
    c.recordShell({ id: 1, command: "git status", phase: "end", code: 0 });
    expect(earlier.progress?.[0]).toEqual({
      id: 1,
      command: "git status",
      status: "running",
      output: "",
    });
    expect(c.snapshot().progress?.[0]).toMatchObject({
      status: "done",
      code: 0,
      output: "\u001b[32mok\u001b[10;22;23;24;25;27;28;29;39;50;54;55;59;65;75m",
    });
  });

  it("records snapshots without a listener", () => {
    const c = new ExecutionProgressController();
    c.recordTrace(startCapabilityTrace(1, 1, "context", "get", []));
    c.flush();
    expect(c.snapshot().traces).toHaveLength(1);
  });
});
