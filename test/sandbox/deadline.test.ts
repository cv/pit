import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExecutionDeadline } from "../../src/sandbox/deadline.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ExecutionDeadline", () => {
  it("starts its clock when the executor first reads the signal", () => {
    const deadline = new ExecutionDeadline(100);
    vi.advanceTimersByTime(500);
    const { signal } = deadline;
    vi.advanceTimersByTime(99);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).name).toBe("TimeoutError");
  });

  it("excludes paused time, counting nested pauses as one", () => {
    const deadline = new ExecutionDeadline(100);
    const { signal } = deadline;
    vi.advanceTimersByTime(60);
    const first = deadline.pause();
    const second = deadline.pause();
    vi.advanceTimersByTime(1_000);
    first();
    first();
    vi.advanceTimersByTime(1_000);
    expect(signal.aborted).toBe(false);
    second();
    vi.advanceTimersByTime(39);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(signal.aborted).toBe(true);
  });

  it("holds a pause taken before the clock starts", () => {
    const deadline = new ExecutionDeadline(50);
    const resume = deadline.pause();
    const { signal } = deadline;
    vi.advanceTimersByTime(1_000);
    expect(signal.aborted).toBe(false);
    resume();
    vi.advanceTimersByTime(50);
    expect(signal.aborted).toBe(true);
    // Resuming after the deadline passed changes nothing.
    deadline.pause()();
    expect(signal.aborted).toBe(true);
  });
});
