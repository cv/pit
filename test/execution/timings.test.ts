import { describe, expect, it } from "vitest";

import { ExecutionTimingRecorder, formatDuration } from "../../src/execution/timings.js";

describe("invocation timings", () => {
  it("partitions elapsed time, copies snapshots, and stops at settlement", () => {
    let now = 100;
    const clock = new ExecutionTimingRecorder(() => now);
    now += 5;
    clock.enter("validation");
    now += 12;
    const partial = clock.snapshot();
    clock.enter("execution");
    now += 30;
    clock.enter("result");
    now += 2;
    const final = clock.finish();
    expect(final).toEqual({
      totalMs: 49,
      phases: { formatting: 5, validation: 12, execution: 30, result: 2 },
    });
    expect(partial).toEqual({ totalMs: 17, phases: { formatting: 5, validation: 12 } });
    now += 1000;
    clock.enter("commit");
    expect(clock.finish()).toEqual(final);
    final.phases.execution = 999;
    expect(clock.snapshot().phases.execution).toBe(30);
  });

  it("accumulates repeated phases and supports zero-duration settlement", () => {
    let now = 0;
    const clock = new ExecutionTimingRecorder(() => now);
    expect(clock.snapshot().totalMs).toBe(0);
    now = 2;
    clock.enter("formatting");
    now = 3;
    expect(clock.finish()).toEqual({ totalMs: 3, phases: { formatting: 3 } });
  });

  it.each<{ name: string; milliseconds: number; shown: string }>([
    { name: "zero", milliseconds: 0, shown: "0ms" },
    { name: "sub-millisecond", milliseconds: 0.4, shown: "0ms" },
    { name: "fast read", milliseconds: 2.2, shown: "2ms" },
    { name: "process", milliseconds: 68, shown: "68ms" },
    { name: "seconds", milliseconds: 1234, shown: "1.2s" },
  ])("formats $name durations", ({ milliseconds, shown }) => {
    expect(formatDuration(milliseconds)).toBe(shown);
  });
});
