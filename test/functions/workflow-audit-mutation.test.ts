import { spawnSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import { skipWithoutJq } from "../helpers/jq.js";
import { loadWorkflowFunction, processResult } from "../helpers/workflow-function.js";

const input = {
  label: "Probe",
  owner: "src/example.ts",
  before: "return 1;",
  after: 'return "$&";',
  files: ["test/example.test.ts"],
};
const passing = {
  numTotalTests: 1,
  numPassedTests: 1,
  numFailedTests: 0,
  numPendingTests: 0,
  testResults: [{ status: "passed", assertionResults: [{ status: "passed" }] }],
};

// Only transport/storage are fake. Execute the emitted Vite transform and actual jq filter.
function harness(
  report: Record<string, unknown>,
  options: { runnerError?: string; cleanupError?: string; omitMarker?: boolean } = {},
) {
  const files = new Map<string, string>();
  let transformed: string | undefined;
  let workflowMutation: Record<string, unknown> | undefined;
  const workspace = {
    edit: vi.fn(
      async (file: string, edit: { changes: Array<{ kind: string; content?: string }> }) => {
        const change = edit.changes[0];
        if (change?.kind === "replaceFile") files.set(file, change.content ?? "");
        else {
          if (options.cleanupError) throw new Error(options.cleanupError);
          files.delete(file);
        }
        return { revision: "revision" };
      },
    ),
    read: vi.fn(async (file: string) => {
      if (!files.has(file)) throw new Error("ENOENT missing report");
      return { revision: "revision", content: files.get(file) };
    }),
  };
  const execFile = vi.fn(async (program: string, args: string[]) => {
    if (options.runnerError) throw new Error(options.runnerError);
    expect(program).toBe("npx");
    const configPath = args[args.indexOf("--config") + 1];
    const source = files.get(configPath ?? "");
    if (!source) throw new Error("Runner received no configuration");
    const module = {
      exports: {} as {
        default?: {
          plugins?: Array<{ transform: (source: string, id: string) => { code: string } }>;
          test?: { env?: Record<string, string> };
        };
      },
    };
    const markers: string[] = [];
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    runInNewContext(compiled, {
      module,
      exports: module.exports,
      require: () => ({ default: {} }),
      console: { error: (message: string) => markers.push(message) },
    });
    const workflow = module.exports.default?.test?.env?.PIT_WORKFLOW_MUTATION;
    if (workflow !== undefined) {
      // Stand in for the workflow test loader, which applies the mutation and records it.
      const mutation = JSON.parse(workflow) as { path: string; after: string; markerFile: string };
      workflowMutation = mutation;
      transformed = mutation.after;
      if (!options.omitMarker) files.set(mutation.markerFile, `${mutation.path}\n`);
    } else {
      const plugin = module.exports.default?.plugins?.[0];
      if (!plugin) throw new Error("No Vite plugin was emitted");
      transformed = plugin.transform(input.before, `/repo/${input.owner}`).code;
    }
    const reportPath = args
      .find((arg) => arg.startsWith("--outputFile="))
      ?.slice("--outputFile=".length);
    if (!reportPath) throw new Error("Runner received no report destination");
    files.set(reportPath, JSON.stringify(report));
    return processResult({
      code: Number(report.numFailedTests) > 0 ? 1 : 0,
      stderr: options.omitMarker ? "" : markers.join("\n"),
    });
  });
  const jq = async ({ file, filter }: { file: string; filter: string }) => {
    const result = spawnSync("jq", ["-c", filter], { input: files.get(file), encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return { values: [JSON.parse(result.stdout)] };
  };
  return {
    dependencies: {
      context: { get: async () => ({ cwd: "/repo" }) },
      workspace,
      shell: { execFile },
      jq,
    },
    files,
    get transformed() {
      return transformed;
    },
    get workflowMutation() {
      return workflowMutation;
    },
  };
}

// The seam tests.probeMutation relies on: the workflow test loader applies a mutation to the named
// source only, records it, and rejects an ambiguous match.
describe("workflow test loader mutation", () => {
  const path = ".pi/functions/ci/inspectTimings.ts";
  const api = vi.fn(async (endpoint: string) =>
    processResult({
      stdout: endpoint.includes("/jobs")
        ? JSON.stringify({
            name: "job",
            conclusion: "success",
            started_at: null,
            completed_at: null,
            steps: [],
          })
        : JSON.stringify({
            name: "CI",
            status: "completed",
            conclusion: "success",
            run_started_at: null,
            updated_at: null,
            head_sha: "abc",
          }),
    }),
  );

  it("applies a mutation to the named source only and records it", async () => {
    const markerFile = join(tmpdir(), `pit-loader-${process.pid}-${Date.now()}.applied`);
    vi.stubEnv(
      "PIT_WORKFLOW_MUTATION",
      JSON.stringify({
        path,
        before: "const JOB_LIMIT = 100;",
        after: "const JOB_LIMIT = 1;",
        markerFile,
      }),
    );
    try {
      const inspect = await loadWorkflowFunction("ci.inspectTimings");
      await loadWorkflowFunction("ci.findRun");
      expect(await inspect({ gh: { api } }, { repo: "cv/pit", id: 7 })).toMatchObject({
        jobsLimited: true,
      });
      expect(await readFile(markerFile, "utf8")).toBe(`${path}\n`);
    } finally {
      vi.unstubAllEnvs();
      await rm(markerFile, { force: true });
    }
  });

  it("rejects a mutation that does not match exactly once", async () => {
    vi.stubEnv(
      "PIT_WORKFLOW_MUTATION",
      JSON.stringify({ path, before: "const", after: "let", markerFile: "/dev/null" }),
    );
    try {
      await expect(loadWorkflowFunction("ci.inspectTimings")).rejects.toThrow(
        "Expected exactly one audit mutation match",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("tests.probeMutation", () => {
  const workflowOwner = ".pi/functions/ci/inspectTimings.ts";

  it.skipIf(skipWithoutJq)(
    "mutates a workflow source through the workflow test loader",
    async () => {
      const probe = await loadWorkflowFunction("tests.probeMutation");
      const failing = {
        ...passing,
        numPassedTests: 0,
        numFailedTests: 1,
        testResults: [
          {
            status: "failed",
            assertionResults: [
              {
                status: "failed",
                fullName: "omits skipped steps",
                failureMessages: ["AssertionError"],
              },
            ],
          },
        ],
      };
      const run = harness(failing);
      const result = await probe(run.dependencies, { ...input, owner: workflowOwner });
      expect(result).toMatchObject({
        mutationApplied: true,
        inconclusive: false,
        report: { failed: 1 },
      });
      expect(run.workflowMutation).toMatchObject({
        path: workflowOwner,
        before: input.before,
        after: input.after,
      });
      // The config, report, and marker file are all removed.
      expect([...run.files.keys()]).toEqual([]);
    },
  );

  it("reports a workflow mutation that no selected test loaded", async () => {
    const probe = await loadWorkflowFunction("tests.probeMutation");
    const run = harness(passing, { omitMarker: true });
    await expect(probe(run.dependencies, { ...input, owner: workflowOwner })).rejects.toThrow(
      `no selected test loaded ${workflowOwner}`,
    );
    expect([...run.files.keys()]).toEqual([]);
  });

  it.each<{ name: string; patch: Record<string, unknown>; error: string }>([
    {
      name: "owner traversal",
      patch: { owner: "src/../outside.ts" },
      error: "explicit src/ or .pi/functions/ owner path",
    },
    {
      name: "an owner outside src and .pi/functions",
      patch: { owner: ".pi/skills/example.ts" },
      error: "explicit src/ or .pi/functions/ owner path",
    },
    { name: "test glob", patch: { files: ["test/**/*.test.ts"] }, error: "explicit test files" },
    { name: "empty test selection", patch: { files: [] }, error: "explicit test files" },
    { name: "unchanged source", patch: { after: input.before }, error: "nontrivial mutation" },
    {
      name: "invalid regular expression",
      patch: { testNamePattern: "[" },
      error: "valid regular expression",
    },
    { name: "multiline pattern", patch: { testNamePattern: "first\nsecond" }, error: "one line" },
  ])("rejects $name before effects", async ({ patch, error }) => {
    const probe = await loadWorkflowFunction("tests.probeMutation");
    const get = vi.fn();
    const edit = vi.fn();
    const read = vi.fn();
    const execFile = vi.fn();
    const jq = vi.fn();
    await expect(
      probe(
        { context: { get }, workspace: { edit, read }, shell: { execFile }, jq },
        { ...input, ...patch },
      ),
    ).rejects.toThrow(error);
    for (const effect of [get, edit, read, execFile, jq]) expect(effect).not.toHaveBeenCalled();
  });

  it.skipIf(skipWithoutJq)(
    "preserves replacement tokens and removes temporary config/report after success",
    async () => {
      const probe = await loadWorkflowFunction("tests.probeMutation");
      const fixture = harness(passing);
      expect(await probe(fixture.dependencies, input)).toMatchObject({
        code: 0,
        mutationApplied: true,
        inconclusive: false,
        report: { passed: 1, failed: 0 },
      });
      expect(fixture.transformed).toBe(input.after);
      expect(fixture.files.size).toBe(0);
    },
  );

  it.skipIf(skipWithoutJq)(
    "bounds noisy assertion and load failures while retaining omissions",
    async () => {
      const probe = await loadWorkflowFunction("tests.probeMutation");
      const fixture = harness({
        numTotalTests: 9,
        numPassedTests: 0,
        numFailedTests: 9,
        numPendingTests: 0,
        testResults: [
          {
            status: "failed",
            assertionResults: Array.from({ length: 9 }, () => ({
              status: "failed",
              fullName: "n".repeat(400),
              failureMessages: [("x".repeat(400) + "\n").repeat(10)],
            })),
          },
          ...Array.from({ length: 5 }, () => ({
            name: "f".repeat(400),
            status: "failed",
            message: "m".repeat(2000),
            assertionResults: [],
          })),
        ],
      });
      const outcome = await probe(fixture.dependencies, input);
      expect(outcome).toMatchObject({
        inconclusive: true,
        report: { failed: 9, failuresOmitted: 4, suiteErrorsOmitted: 2 },
      });
      const report = outcome.report as {
        failures: Array<{ name: string; reason: string; reasonTruncated: boolean }>;
        suiteErrors: Array<{ message: string; messageTruncated: boolean }>;
      };
      expect(report.failures).toHaveLength(5);
      expect(report.suiteErrors).toHaveLength(3);
      for (const failure of report.failures) {
        expect(failure.name.length).toBeLessThanOrEqual(200);
        expect(failure.reason.length).toBeLessThanOrEqual(803);
        expect(failure.reasonTruncated).toBe(true);
      }
      for (const error of report.suiteErrors) {
        expect(error.message.length).toBeLessThanOrEqual(1000);
        expect(error.messageTruncated).toBe(true);
      }
      expect(fixture.files.size).toBe(0);
    },
  );

  it.skipIf(skipWithoutJq)("marks a run with no executed assertions inconclusive", async () => {
    const probe = await loadWorkflowFunction("tests.probeMutation");
    const fixture = harness({
      numTotalTests: 0,
      numPassedTests: 0,
      numFailedTests: 0,
      numPendingTests: 0,
      testResults: [],
    });
    expect(await probe(fixture.dependencies, input)).toMatchObject({ inconclusive: true });
  });

  it("rejects an unobserved mutation and cleans up both artifacts", async () => {
    const probe = await loadWorkflowFunction("tests.probeMutation");
    const fixture = harness(passing, { omitMarker: true });
    await expect(probe(fixture.dependencies, input)).rejects.toThrow("Mutation was not observed");
    expect(fixture.files.size).toBe(0);
  });

  it("preserves runner failure alongside cleanup failure", async () => {
    const probe = await loadWorkflowFunction("tests.probeMutation");
    const fixture = harness(passing, {
      runnerError: "runner crashed",
      cleanupError: "EACCES cleanup denied",
    });
    const message = await probe(fixture.dependencies, input).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    expect(message).toContain("runner crashed");
    expect(message).toContain("Cleanup error:");
    expect(message).toContain("EACCES cleanup denied");
    // Cleanup is attempted for every temporary file: config, report, and marker.
    expect(fixture.dependencies.workspace.read).toHaveBeenCalledTimes(3);
  });
});
