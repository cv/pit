import { describe, expect, it, vi } from "vitest";

import { loadWorkflowFunction, processResult } from "../helpers/workflow-function.js";

describe("runPitTargetedTests behavior", () => {
  it("runs only the distinct requested files and returns their diagnostic output", async () => {
    const run = await loadWorkflowFunction("runPitTargetedTests");
    const execFile = vi.fn(async (_program: string, _args: string[]) =>
      processResult({ stdout: "tests passed", stderr: "extra diagnostic" }),
    );
    const result = await run(
      { shell: { execFile } },
      { files: ["test/a.test.ts", "test/b.test.ts", "test/a.test.ts"] },
    );
    expect(new Set(result.files as string[])).toEqual(
      new Set(["test/a.test.ts", "test/b.test.ts"]),
    );
    expect(result.summary).toContain("tests passed");
    expect(result.summary).toContain("extra diagnostic");
    expect(execFile).toHaveBeenCalledOnce();
    const [program, args] = execFile.mock.calls[0] ?? [];
    expect(program).toBe("npx");
    expect(args?.slice(0, 2)).toEqual(["vitest", "run"]);
    expect(args?.slice(2).sort()).toEqual(["test/a.test.ts", "test/b.test.ts"]);
  });

  it.each<{ name: string; files: string[] }>([
    { name: "empty selection", files: [] },
    { name: "too many files", files: Array.from({ length: 21 }, (_, i) => `test/${i}.test.ts`) },
    { name: "parent traversal", files: ["test/../outside.test.ts"] },
    { name: "outside test directory", files: ["src/a.test.ts"] },
    { name: "non-test source", files: ["test/a.ts"] },
    { name: "shell punctuation", files: ["test/a;echo.test.ts"] },
    { name: "newline", files: ["test/a\nb.test.ts"] },
  ])("rejects $name before starting a process", async ({ files }) => {
    const run = await loadWorkflowFunction("runPitTargetedTests");
    const execFile = vi.fn();
    await expect(run({ shell: { execFile } }, { files })).rejects.toThrow();
    expect(execFile).not.toHaveBeenCalled();
  });

  it("reports a failing test's tail rather than silently accepting a nonzero exit", async () => {
    const run = await loadWorkflowFunction("runPitTargetedTests");
    const execFile = async () =>
      processResult({
        code: 1,
        stdout: "OMITTED_HEAD\n" + "noise\n".repeat(200),
        stderr: "FAILURE_SENTINEL",
      });
    let error: unknown;
    try {
      await run({ shell: { execFile } }, { files: ["test/a.test.ts"] });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("FAILURE_SENTINEL");
    expect(String(error)).not.toContain("OMITTED_HEAD");
    expect(String(error).split("\n").length).toBeLessThan(130);
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

describe("inspectPitCoverageGaps behavior", () => {
  it("interprets uncovered markers, decodes code, and retains file/line attribution", async () => {
    const inspect = await loadWorkflowFunction("inspectPitCoverageGaps");
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
    const inspect = await loadWorkflowFunction("inspectPitCoverageGaps");
    const result = await inspect(
      { workspace: coverageWorkspace() },
      { files: ["src/a.ts", "src/b.ts"], limit: 2 },
    );
    expect(result.gaps).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("reports unavailable artifacts rather than claiming there are no gaps", async () => {
    const inspect = await loadWorkflowFunction("inspectPitCoverageGaps");
    const missing = async () => {
      throw new Error("missing artifact");
    };
    const result = await inspect({ workspace: { read: missing, search: missing } });
    expect(result.available).toBe(false);
    expect(result.message).toMatch(/coverage/i);
  });
});
