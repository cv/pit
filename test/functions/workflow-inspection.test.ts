import { describe, expect, it, vi } from "vitest";

import { loadWorkflowFunction, processResult } from "../helpers/workflow-function.js";

const report = (overrides: Record<string, unknown> = {}) => ({
  values: [
    {
      counts: { files: 1, tests: 2, passed: 2, failed: 0, skipped: 0 },
      failures: [],
      failuresOmitted: 0,
      suiteErrors: [],
      suiteErrorsOmitted: 0,
      slowestFiles: [{ file: "/repo/test/a.test.ts", ms: 120 }],
      slowestTests: [{ file: "/repo/test/a.test.ts", test: "a works", ms: 80 }],
      ...overrides,
    },
  ],
});
const vitestArgs = (execFile: { mock: { calls: unknown[][] } }) =>
  (execFile.mock.calls as Array<[string, string[]]>)
    .filter(([program]) => program === "npx")
    .map(([, args]) => args);

describe("tests.runTargeted behavior", () => {
  it("runs only the distinct requested files and returns their diagnostic output", async () => {
    const run = await loadWorkflowFunction("tests.runTargeted");
    const execFile = vi.fn(async (_program: string, _args: string[]) =>
      processResult({ stdout: "tests passed", stderr: "extra diagnostic" }),
    );
    const jq = vi.fn().mockResolvedValue(report());
    const result = await run(
      { shell: { execFile }, jq },
      { files: ["test/a.test.ts", "test/b.test.ts", "test/a.test.ts"] },
    );
    expect(new Set(result.files as string[])).toEqual(
      new Set(["test/a.test.ts", "test/b.test.ts"]),
    );
    expect(result.summary).toContain("tests passed");
    expect(result.summary).toContain("extra diagnostic");
    expect(result).toMatchObject({ code: 0, counts: { passed: 2, failed: 0 }, failures: [] });
    expect(result).not.toHaveProperty("slowestFiles");
    const invocations = vitestArgs(execFile);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.slice(0, 2)).toEqual(["vitest", "run"]);
    expect(invocations[0]?.filter((arg) => arg.startsWith("test/")).sort()).toEqual([
      "test/a.test.ts",
      "test/b.test.ts",
    ]);
  });

  it("reads the JSON report it requested and removes it afterwards", async () => {
    const run = await loadWorkflowFunction("tests.runTargeted");
    const events: string[] = [];
    const execFile = vi.fn(async (program: string, args: string[]) => {
      events.push(`${program} ${args.join(" ")}`);
      return processResult();
    });
    const jq = vi.fn(async (input: { file: string }) => {
      events.push(`jq ${input.file}`);
      return report();
    });
    await run({ shell: { execFile }, jq }, { files: ["test/a.test.ts"] });
    const [args] = vitestArgs(execFile);
    expect(args).toContain("--reporter=json");
    const reportFile = args
      ?.find((arg) => arg.startsWith("--outputFile.json="))
      ?.slice("--outputFile.json=".length);
    expect(reportFile).toMatch(/^node_modules\/\.vitest\/.+\.json$/);
    expect(events.slice(1)).toEqual([`jq ${reportFile}`, `rm -f -- ${reportFile}`]);
  });

  it("passes a name pattern and reports repository-relative timings only on request", async () => {
    const run = await loadWorkflowFunction("tests.runTargeted");
    const execFile = vi.fn(async (_program: string, _args: string[]) => processResult());
    const jq = vi.fn().mockResolvedValue(report());
    const result = await run(
      { shell: { execFile }, jq },
      { files: ["test/a.test.ts"], testNamePattern: "a works", slowest: 3 },
    );
    expect(vitestArgs(execFile)[0]?.join(" ")).toContain("-t a works");
    expect(jq.mock.calls[0]?.[0]).toMatchObject({
      variables: expect.objectContaining({ slowest: 3 }),
    });
    expect(result.slowestFiles).toEqual([{ file: "test/a.test.ts", ms: 120 }]);
    expect(result.slowestTests).toEqual([{ file: "test/a.test.ts", test: "a works", ms: 80 }]);
  });

  it.each<{ name: string; input: Record<string, unknown> }>([
    { name: "empty selection", input: { files: [] } },
    {
      name: "too many files",
      input: { files: Array.from({ length: 21 }, (_, i) => `test/${i}.test.ts`) },
    },
    { name: "parent traversal", input: { files: ["test/../outside.test.ts"] } },
    { name: "outside test directory", input: { files: ["src/a.test.ts"] } },
    { name: "non-test source", input: { files: ["test/a.ts"] } },
    { name: "shell punctuation", input: { files: ["test/a;echo.test.ts"] } },
    { name: "newline", input: { files: ["test/a\nb.test.ts"] } },
    { name: "empty name pattern", input: { files: ["test/a.test.ts"], testNamePattern: "" } },
    {
      name: "multiline name pattern",
      input: { files: ["test/a.test.ts"], testNamePattern: "a\nb" },
    },
    { name: "fractional slowest", input: { files: ["test/a.test.ts"], slowest: 1.5 } },
    { name: "slowest above 20", input: { files: ["test/a.test.ts"], slowest: 21 } },
  ])("rejects $name before starting a process", async ({ input }) => {
    const run = await loadWorkflowFunction("tests.runTargeted");
    const execFile = vi.fn();
    const jq = vi.fn();
    await expect(run({ shell: { execFile }, jq }, input)).rejects.toThrow();
    expect(execFile).not.toHaveBeenCalled();
  });

  it("reports failures from the JSON report instead of the noisy output tail", async () => {
    const run = await loadWorkflowFunction("tests.runTargeted");
    const execFile = vi.fn(async (_program: string, _args: string[]) =>
      processResult({ code: 1, stdout: "NOISE\n".repeat(300) }),
    );
    const jq = vi.fn().mockResolvedValue(
      report({
        counts: { files: 2, tests: 6, passed: 2, failed: 4, skipped: 0 },
        failures: [
          {
            file: "/repo/test/a.test.ts",
            test: "a breaks",
            line: 42,
            message:
              "\u001b[31mAssertionError: expected 1 to be 2\u001b[39m\n    at /repo/test/a.test.ts:42:7",
          },
        ],
        failuresOmitted: 3,
        suiteErrors: [
          { file: "/repo/test/b.test.ts", message: "Cannot find module './missing.js'" },
        ],
      }),
    );
    const files = ["test/a.test.ts", "test/b.test.ts"];
    const message = await run({ shell: { execFile }, jq }, { files }).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    expect(message).toContain("4 failed, 2 passed");
    expect(message).toContain("test/a.test.ts:42 › a breaks");
    expect(message).toContain("AssertionError: expected 1 to be 2");
    expect(message).toContain("at test/a.test.ts:42:7");
    expect(message).toContain("3 more failures omitted");
    expect(message).toContain("Cannot find module './missing.js'");
    expect(message).not.toContain("NOISE");
    expect(message).not.toContain("/repo/");
    expect(message).not.toContain("\u001b[");

    expect(await run({ shell: { execFile }, jq }, { files, raise: false })).toMatchObject({
      code: 1,
      failures: [{ file: "test/a.test.ts", test: "a breaks", line: 42 }],
      failuresOmitted: 3,
      suiteErrors: [{ file: "test/b.test.ts" }],
    });
  });

  it("falls back to the output tail when no JSON report was written", async () => {
    const run = await loadWorkflowFunction("tests.runTargeted");
    const execFile = vi.fn(async (program: string, _args: string[]) =>
      program === "npx"
        ? processResult({
            code: 1,
            stdout: "OMITTED_HEAD\n" + "noise\n".repeat(200),
            stderr: "FAILURE_SENTINEL",
          })
        : processResult(),
    );
    const jq = vi.fn().mockRejectedValue(new Error("missing report"));
    const message = await run({ shell: { execFile }, jq }, { files: ["test/a.test.ts"] }).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    expect(message).toContain("wrote no JSON report");
    expect(message).toContain("FAILURE_SENTINEL");
    expect(message).not.toContain("OMITTED_HEAD");
    expect(message.split("\n").length).toBeLessThan(130);
    expect(execFile).toHaveBeenLastCalledWith(
      "rm",
      expect.arrayContaining(["-f", "--"]),
      expect.anything(),
    );
  });
});

const html: Record<string, string[]> = {
  "coverage/src/a.ts.html": [
    '<span class="cstat-no">const value = &quot;&lt;tag&gt;&quot;;</span>',
    '<span class="cbranch-no">left &amp;&amp; right</span>',
    '<span class="fstat-no">function missing() {}</span>',
    '<span class="cstat-yes">covered();</span>',
  ],
  "coverage/src/b.ts.html": ['<span class="cstat-no">uncovered();</span>'],
};
function coverageWorkspace() {
  return {
    read: async () => ({
      content: JSON.stringify({
        total: {
          statements: { pct: 80 },
          branches: { pct: 70 },
          functions: { pct: 60 },
          lines: { pct: 90 },
        },
      }),
    }),
    search: vi.fn(
      async (query: string, options: { path: string; regex?: boolean; limit: number }) => {
        const pattern = options.regex ? new RegExp(query) : undefined;
        const matches = Object.entries(html)
          .filter(([file]) => options.path === "coverage" || options.path === file)
          .flatMap(([file, lines]) =>
            lines.flatMap((text, index) =>
              (pattern ? pattern.test(text) : text.includes(query))
                ? [{ file, line: index + 1, text }]
                : [],
            ),
          );
        return {
          matches: matches.slice(0, options.limit),
          truncated: matches.length > options.limit,
        };
      },
    ),
  };
}

describe("tests.inspectCoverageGaps behavior", () => {
  it("interprets uncovered markers, decodes code, and retains file/line attribution", async () => {
    const inspect = await loadWorkflowFunction("tests.inspectCoverageGaps");
    const workspace = coverageWorkspace();
    const result = await inspect(
      { workspace },
      { files: ["src/a.ts", "src/a.ts", "src/b.ts"], limit: 10 },
    );
    expect(result).toMatchObject({
      available: true,
      truncated: false,
      totals: { statements: 80, branches: 70, functions: 60, lines: 90 },
    });
    expect(result.gaps).toHaveLength(4);
    expect(result.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "src/a.ts",
          coverageLine: 1,
          kind: "statement",
          code: 'const value = "<tag>";',
        }),
        expect.objectContaining({
          file: "src/a.ts",
          coverageLine: 2,
          kind: "branch",
          code: "left && right",
        }),
        expect.objectContaining({
          file: "src/a.ts",
          coverageLine: 3,
          kind: "function",
          code: "function missing() {}",
        }),
        expect.objectContaining({ file: "src/b.ts", kind: "statement", code: "uncovered();" }),
      ]),
    );
  });

  it("applies the output limit across files and makes omission explicit", async () => {
    const inspect = await loadWorkflowFunction("tests.inspectCoverageGaps");
    const result = await inspect(
      { workspace: coverageWorkspace() },
      { files: ["src/a.ts", "src/b.ts"], limit: 2 },
    );
    expect(result.gaps).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("reports unavailable artifacts rather than claiming there are no gaps", async () => {
    const inspect = await loadWorkflowFunction("tests.inspectCoverageGaps");
    const missing = async () => {
      throw new Error("missing artifact");
    };
    const result = await inspect({ workspace: { read: missing, search: missing } });
    expect(result.available).toBe(false);
    expect(result.message).toMatch(/coverage/i);
  });
});
