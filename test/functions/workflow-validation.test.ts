import { describe, expect, it, vi } from "vitest";

import { loadWorkflowFunction, processResult } from "../helpers/workflow-function.js";

type Result = ReturnType<typeof processResult>;
function deferredResult() {
  let resolve!: (value: Result) => void;
  const promise = new Promise<Result>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, finish: () => resolve(processResult()) };
}

describe("validatePit workflow behavior", () => {
  it("starts independent gates together, then waits before coverage and packaging", async () => {
    const validate = await loadWorkflowFunction("validatePit");
    const check = deferredResult();
    const tests = deferredResult();
    const coverage = deferredResult();
    const started: string[] = [];
    const run = vi.fn((script: string) => {
      started.push(script);
      return script === "check"
        ? check.promise
        : script === "coverage"
          ? coverage.promise
          : Promise.resolve(processResult());
    });
    const test = vi.fn(() => {
      started.push("tests");
      return tests.promise;
    });
    const pending = validate({ npm: { run, test } }, { coverage: true, packageCheck: true });
    await vi.waitFor(() => expect(started).toEqual(expect.arrayContaining(["check", "tests"])));
    expect(started).not.toContain("coverage");
    check.finish();
    await Promise.resolve();
    expect(started).not.toContain("coverage");
    tests.finish();
    await vi.waitFor(() => expect(started).toContain("coverage"));
    expect(started).not.toContain("package:check");
    coverage.finish();
    expect(await pending).toEqual({ check: 0, tests: 0, coverage: 0, packageCheck: 0 });
    expect(started.filter((stage) => stage === "tests")).toHaveLength(1);
    expect(started.filter((stage) => stage === "coverage")).toHaveLength(1);
  });

  it.each([
    { name: "default gates", coverage: false, packageCheck: false },
    { name: "coverage only", coverage: true, packageCheck: false },
    { name: "packaging only", coverage: false, packageCheck: true },
    { name: "all gates", coverage: true, packageCheck: true },
  ])(
    "runs $name without duplicating or adding unrequested gates",
    async ({ coverage, packageCheck }) => {
      const validate = await loadWorkflowFunction("validatePit");
      const run = vi.fn(async (_script: string) => processResult());
      const test = vi.fn(async () => processResult());
      const output = await validate({ npm: { run, test } }, { coverage, packageCheck });
      expect(run.mock.calls.map(([script]) => script).sort()).toEqual(
        [
          "check",
          ...(coverage ? ["coverage"] : []),
          ...(packageCheck ? ["package:check"] : []),
        ].sort(),
      );
      expect(test).toHaveBeenCalledOnce();
      expect(output.coverage).toBe(coverage ? 0 : undefined);
      expect(output.packageCheck).toBe(packageCheck ? 0 : undefined);
    },
  );

  it.each([
    { stage: "check", forbidden: ["coverage", "package:check"] },
    { stage: "tests", forbidden: ["coverage", "package:check"] },
    { stage: "coverage", forbidden: ["package:check"] },
    { stage: "package:check", forbidden: [] },
  ])(
    "stops after $stage fails and retains a bounded diagnostic tail",
    async ({ stage, forbidden }) => {
      const validate = await loadWorkflowFunction("validatePit");
      const calls: string[] = [];
      const execute = async (name: string, options: { raise?: boolean } = {}) => {
        calls.push(name);
        const result =
          name === stage
            ? processResult({
                code: 2,
                stdout: "OMITTED_HEAD\n" + "noise\n".repeat(200),
                stderr: "DECISIVE_DIAGNOSTIC",
              })
            : processResult();
        if (options.raise && result.code !== 0) throw new Error("raw process failure");
        return result;
      };
      let error: unknown;
      try {
        await validate(
          {
            npm: {
              run: (name: string, _args: string[], options: { raise?: boolean }) =>
                execute(name, options),
              test: (options: { raise?: boolean }) => execute("tests", options),
            },
          },
          { coverage: true, packageCheck: true },
        );
      } catch (caught) {
        error = caught;
      }
      const message = String(error);
      expect(message).toContain(stage);
      expect(message).toContain("DECISIVE_DIAGNOSTIC");
      expect(message).not.toContain("OMITTED_HEAD");
      expect(message.length).toBeLessThan(13_000);
      for (const skipped of forbidden) expect(calls).not.toContain(skipped);
    },
  );
});
