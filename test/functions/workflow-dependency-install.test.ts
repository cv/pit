import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadWorkflowFunction, processResult } from "../helpers/workflow-function.js";

const execute = promisify(execFile);
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pit-install-test-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function inspect(input?: Record<string, unknown>) {
  const run = await loadWorkflowFunction("delivery.inspectDependencies");
  return run(
    {
      shell: {
        execFile: async (program: string, args: string[]) => {
          const output = await execute(program, args, {
            cwd: directory,
            timeout: 15000,
            maxBuffer: 100000,
          });
          return processResult(output);
        },
      },
    },
    input,
  );
}

async function fixture(options: {
  installed?: string;
  lock?: string;
  version?: number;
  requirement?: string;
}) {
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ dependencies: { fixture: options.requirement ?? "^1.0.0" } }),
  );
  if (options.version !== undefined || options.lock !== undefined) {
    await writeFile(
      join(directory, "package-lock.json"),
      options.lock ??
        JSON.stringify({
          lockfileVersion: options.version,
          packages: {
            "": { dependencies: { fixture: "^1.0.0" } },
            "node_modules/fixture": { version: "1.0.0" },
          },
        }),
    );
  }
  if (options.installed !== undefined) {
    await mkdir(join(directory, "node_modules/fixture"), { recursive: true });
    await writeFile(
      join(directory, "node_modules/fixture/package.json"),
      options.installed === "{" ? "{" : JSON.stringify({ version: options.installed }),
    );
  }
}

describe("delivery.inspectDependencies", () => {
  it.each<{
    name: string;
    installed?: string;
    lock?: string;
    version?: number;
    requirement?: string;
    issues: string[];
    matchesLock: boolean | null;
  }>([
    { name: "matching v3 install", installed: "1.0.0", version: 3, issues: [], matchesLock: true },
    { name: "matching v2 install", installed: "1.0.0", version: 2, issues: [], matchesLock: true },
    {
      name: "stale installed version",
      installed: "0.9.0",
      version: 3,
      issues: ["installed-version-mismatch"],
      matchesLock: false,
    },
    {
      name: "manifest-lock drift",
      installed: "1.0.0",
      version: 3,
      requirement: "^2.0.0",
      issues: ["manifest-lock-mismatch"],
      matchesLock: false,
    },
    { name: "missing install", version: 3, issues: ["not-installed"], matchesLock: false },
    {
      name: "malformed installed metadata",
      installed: "{",
      version: 3,
      issues: ["installed-metadata-unreadable"],
      matchesLock: false,
    },
    {
      name: "missing lockfile",
      installed: "1.0.0",
      issues: ["lock-unavailable-or-unsupported"],
      matchesLock: null,
    },
    {
      name: "malformed lockfile",
      installed: "1.0.0",
      lock: "{",
      issues: ["lock-unavailable-or-unsupported"],
      matchesLock: null,
    },
    {
      name: "unsupported lockfile",
      installed: "1.0.0",
      version: 1,
      issues: ["lock-unavailable-or-unsupported"],
      matchesLock: null,
    },
  ])(
    "reports $name from real package files",
    async ({ name: _name, issues, matchesLock, ...options }) => {
      await fixture(options);
      const result = await inspect();
      expect(result).toMatchObject({
        complete: true,
        inspected: 1,
        omitted: 0,
        matchesLock,
        dependencies: [{ name: "fixture", issues }],
      });
    },
  );

  it("deduplicates selection and does not claim an omitted package matches", async () => {
    await fixture({ installed: "1.0.0", version: 3 });
    const result = await inspect({ packages: ["fixture", "fixture", "missing"], limit: 1 });
    expect(result).toMatchObject({
      total: 2,
      inspected: 1,
      omitted: 1,
      complete: false,
      matchesLock: null,
    });
    expect(result.dependencies).toHaveLength(1);
  });

  it.each<{ name: string; input: Record<string, unknown> }>([
    { name: "path traversal", input: { packages: ["../package.json"] } },
    { name: "empty selection", input: { packages: [] } },
    {
      name: "too many packages",
      input: { packages: Array.from({ length: 31 }, (_, i) => `package-${i}`) },
    },
    { name: "zero limit", input: { limit: 0 } },
    { name: "fractional limit", input: { limit: 1.5 } },
  ])("rejects $name before effects", async ({ input }) => {
    const run = await loadWorkflowFunction("delivery.inspectDependencies");
    const execFile = vi.fn();
    await expect(run({ shell: { execFile } }, input)).rejects.toThrow();
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each<{ name: string; output: ReturnType<typeof processResult>; error: string }>([
    {
      name: "process failure",
      output: processResult({ code: 1, stderr: "Cannot inspect package.json" }),
      error: "Cannot inspect package.json",
    },
    {
      name: "truncated valid JSON",
      output: processResult({ stdout: "{}", truncated: true }),
      error: "truncated",
    },
  ])("rejects $name rather than returning incomplete evidence", async ({ output, error }) => {
    const run = await loadWorkflowFunction("delivery.inspectDependencies");
    await expect(run({ shell: { execFile: async () => output } })).rejects.toThrow(error);
  });
});
