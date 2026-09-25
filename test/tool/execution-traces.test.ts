import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExecutionTimings } from "../../src/execution/timings.js";
import type { ExecutionProgressSnapshot } from "../../src/execution/types.js";
import {
  cleanupHarness,
  context,
  setupHarness,
  tool,
  toolResult,
} from "../support/extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

function expectPartition(timing: ExecutionTimings) {
  expect(timing.totalMs).toBeGreaterThanOrEqual(0);
  const phases = Object.values(timing.phases);
  expect(phases.every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
  expect(phases.reduce((sum, value) => sum + value, 0)).toBeCloseTo(timing.totalMs, 5);
}

describe("retained execution traces", () => {
  it("settles timing for an already-cancelled invocation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      tool.execute(
        "cancelled",
        { code: "async ({}) => 42" },
        controller.signal,
        undefined,
        context(),
      ),
    ).rejects.toThrow("cancelled");
    const result = toolResult({ toolName: "typescript", toolCallId: "cancelled", isError: true });
    expectPartition(result.details.timings);
    expect(result.details.failure.kind).toBe("cancelled");
    expect(result.details.timings.phases).not.toHaveProperty("commit");
  });

  it("isolates progress identity across overlapping tool invocations", async () => {
    const code = `async ({ context: { get }, shell: { execFile } }, input: { prefix: number; program: string; text: string }) => {
      for (let i = 0; i < input.prefix; i++) await get();
      return execFile(input.program, ['-e', 'setTimeout(() => console.log(' + JSON.stringify(input.text) + '), 80)']);
    }`;
    const run = (prefix: number, text: string) =>
      tool.execute(
        text,
        { code, params: { prefix, program: process.execPath, text } },
        undefined,
        () => {},
        context(),
      );
    const [left, right] = await Promise.all([run(1, "LEFT"), run(2, "RIGHT")]);
    expect(left.details.progress).toMatchObject([{ id: 1, traceSequence: 2, output: "LEFT\n" }]);
    expect(right.details.progress).toMatchObject([{ id: 1, traceSequence: 3, output: "RIGHT\n" }]);
  });
  it.each([
    { name: "pure value", code: "async ({}) => 42", saveOnly: false },
    {
      name: "save-only definition",
      code: "async function pure({}) { return 42; }",
      saveOnly: true,
    },
  ])(
    "retains timings for a $name without inventing capability calls",
    async ({ code, saveOnly }) => {
      const result = await tool.execute(
        "timing",
        { code, saveOnly },
        undefined,
        undefined,
        context(),
      );
      expectPartition(result.details.timings);
      expect(result.details.traces).toBeUndefined();
      const phases = result.details.timings.phases;
      expect(phases).toHaveProperty("formatting");
      expect(phases).toHaveProperty("preparation");
      expect(phases).toHaveProperty("commit");
      expect(phases).toHaveProperty("result");
      expect(Object.hasOwn(phases, "execution")).toBe(!saveOnly);
      expect(result.details.value).toEqual(
        saveOnly ? { savedFunction: "pure", executed: false } : 42,
      );
    },
  );

  // Budgets leave room for runtime startup, so only the timeout row reaches its deadline.
  it.each([
    {
      name: "validation rejection",
      code: "async ({}) => missingName",
      timeoutMs: 10_000,
      phase: "validation",
      kind: "user",
    },
    {
      name: "guest failure",
      code: "async ({}) => { throw new Error('intentional'); }",
      timeoutMs: 10_000,
      phase: "execution",
      kind: "user",
    },
    {
      name: "unsettled promise",
      code: "async ({}) => new Promise(() => {})",
      timeoutMs: 10_000,
      phase: "execution",
      kind: "user",
    },
    {
      name: "timeout",
      code: "async ({}) => { for (;;) {} }",
      timeoutMs: 500,
      phase: "execution",
      kind: "timeout",
    },
  ])(
    "retains completed and interrupted phases on $name",
    async ({ code, timeoutMs, phase, kind }) => {
      await expect(
        tool.execute("failure", { code, timeoutMs }, undefined, undefined, context()),
      ).rejects.toThrow();
      const enriched = toolResult({ toolName: "typescript", toolCallId: "failure", isError: true });
      expectPartition(enriched.details.timings);
      expect(enriched.details.timings.phases).toHaveProperty(phase);
      expect(enriched.details.timings.phases).not.toHaveProperty("result");
      expect(enriched.details.failure.kind).toBe(kind);
    },
  );

  it("links overlapping processes to their own host trace, not the process counter", async () => {
    const updates: ExecutionProgressSnapshot[] = [];
    const code = `async ({ context: { get }, shell: { execFile } }, input: { program: string }) => {
      await get();
      return Promise.all([
        execFile(input.program, ['-e', "setTimeout(() => process.stdout.write('FIRST'), 350)"]),
        execFile(input.program, ['-e', "process.stdout.write('SECOND')"]),
      ]);
    }`;
    const result = await tool.execute(
      "linked",
      { code, params: { program: process.execPath } },
      undefined,
      (update: { details: ExecutionProgressSnapshot }) => updates.push(update.details),
      context(),
    );
    const details = result.details as ExecutionProgressSnapshot;
    expectPartition(result.details.timings);
    expect(details.progress?.map((entry) => [entry.id, entry.traceSequence, entry.output])).toEqual(
      [
        [1, 2, "FIRST"],
        [2, 3, "SECOND"],
      ],
    );
    for (const entry of details.progress ?? []) {
      expect(details.traces?.find((trace) => trace.sequence === entry.traceSequence)).toMatchObject(
        { capability: "shell", method: "execFile", status: "succeeded" },
      );
    }
    expect(
      updates.some((update) => update.progress?.some((entry) => entry.status === "running")),
    ).toBe(true);
    expect(result.details.value.map((entry: { stdout: string }) => entry.stdout)).toEqual([
      "FIRST",
      "SECOND",
    ]);
  });
});
