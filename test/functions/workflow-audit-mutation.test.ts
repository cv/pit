import { spawnSync } from "node:child_process";
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
          plugins: Array<{ transform: (source: string, id: string) => { code: string } }>;
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
    const plugin = module.exports.default?.plugins[0];
    if (!plugin) throw new Error("No Vite plugin was emitted");
    transformed = plugin.transform(input.before, `/repo/${input.owner}`).code;
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
  };
}

describe("probePitAuditMutation", () => {
  it.each<{ name: string; patch: Record<string, unknown>; error: string }>([
    {
      name: "owner traversal",
      patch: { owner: "src/../outside.ts" },
      error: "explicit source owner path",
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
    const probe = await loadWorkflowFunction("probePitAuditMutation");
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
      const probe = await loadWorkflowFunction("probePitAuditMutation");
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
      const probe = await loadWorkflowFunction("probePitAuditMutation");
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
    const probe = await loadWorkflowFunction("probePitAuditMutation");
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
    const probe = await loadWorkflowFunction("probePitAuditMutation");
    const fixture = harness(passing, { omitMarker: true });
    await expect(probe(fixture.dependencies, input)).rejects.toThrow("Mutation was not observed");
    expect(fixture.files.size).toBe(0);
  });

  it("preserves runner failure alongside cleanup failure", async () => {
    const probe = await loadWorkflowFunction("probePitAuditMutation");
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
    expect(fixture.dependencies.workspace.read).toHaveBeenCalledTimes(2);
  });
});
