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

// Installed dependencies that match the lockfile, so only the gates under test decide.
const clean = {
  delivery: { inspectDependencies: async () => ({ stale: [], dependencies: [] }) },
};

describe("delivery.validate workflow behavior", () => {
  it.each([
    {
      name: "a stale install",
      issues: ["installed-version-mismatch"],
      optional: false,
      fails: true,
    },
    {
      name: "a manifest the lockfile doesn't match",
      issues: ["manifest-lock-mismatch"],
      optional: false,
      fails: true,
    },
    { name: "a missing required package", issues: ["not-installed"], optional: false, fails: true },
    { name: "a missing optional package", issues: ["not-installed"], optional: true, fails: false },
  ])("checks installed dependencies first: $name", async ({ issues, optional, fails }) => {
    const validate = await loadWorkflowFunction("delivery.validate");
    const run = vi.fn(async (_script: string) => processResult());
    const test = vi.fn(async () => processResult());
    const dependency = {
      name: "@earendil-works/pi-coding-agent",
      declared: "^1.0.2",
      lockedVersion: "1.0.2",
      installedVersion: "0.99.2",
      optional,
      issues,
    };
    const delivery = {
      inspectDependencies: async () => ({
        stale: fails ? [dependency.name] : [],
        dependencies: [dependency],
      }),
    };
    const pending = validate({ delivery, npm: { run, test } });
    if (fails) {
      await expect(pending).rejects.toThrow(
        /npm ci[\s\S]*@earendil-works\/pi-coding-agent: declared \^1\.0\.2, locked 1\.0\.2, installed 0\.99\.2/,
      );
      expect(run).not.toHaveBeenCalled();
      expect(test).not.toHaveBeenCalled();
    } else {
      await expect(pending).resolves.toMatchObject({ check: 0, tests: 0 });
    }
  });

  it("skips the dependency check for an intentional local override", async () => {
    const validate = await loadWorkflowFunction("delivery.validate");
    const inspectDependencies = vi.fn();
    const run = vi.fn(async (_script: string) => processResult());
    const test = vi.fn(async () => processResult());
    await expect(
      validate({ delivery: { inspectDependencies }, npm: { run, test } }, { dependencies: false }),
    ).resolves.toMatchObject({ check: 0, tests: 0 });
    expect(inspectDependencies).not.toHaveBeenCalled();
  });

  it("starts independent gates together, then waits before coverage and packaging", async () => {
    const validate = await loadWorkflowFunction("delivery.validate");
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
    const pending = validate(
      { ...clean, npm: { run, test } },
      { coverage: true, packageCheck: true },
    );
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
      const validate = await loadWorkflowFunction("delivery.validate");
      const run = vi.fn(async (_script: string) => processResult());
      const test = vi.fn(async () => processResult());
      const output = await validate({ ...clean, npm: { run, test } }, { coverage, packageCheck });
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
      const validate = await loadWorkflowFunction("delivery.validate");
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
            ...clean,
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
