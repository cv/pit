import { describe, expect, it, vi } from "vitest";

import { loadWorkflowFunction, processResult } from "../helpers/workflow-function.js";

const at = (seconds: number) => new Date(Date.UTC(2026, 8, 25, 12, 0, seconds)).toISOString();
const step = (name: string, start: number, end: number, conclusion = "success") => ({
  name,
  conclusion,
  started_at: at(start),
  completed_at: at(end),
});

function github(jobs: unknown[], truncated = false) {
  return vi.fn(async (path: string, _args: string[]) =>
    path.endsWith("/jobs?per_page=100")
      ? processResult({ stdout: jobs.map((job) => JSON.stringify(job)).join("\n"), truncated })
      : processResult({
          stdout: JSON.stringify({
            name: "Release",
            status: "completed",
            conclusion: "success",
            run_started_at: at(0),
            updated_at: at(50),
            head_sha: "abc123",
          }),
        }),
  );
}

describe("ci.inspectTimings", () => {
  it("times the run, its jobs, and matching steps that ran", async () => {
    const inspect = await loadWorkflowFunction("ci.inspectTimings");
    const api = github([
      {
        ...step("linux-x64 addon", 1, 31),
        steps: [
          step("Set up", 1, 3),
          step("Build native addon", 3, 28),
          step("Test", 28, 31, "skipped"),
        ],
      },
      { ...step("suite", 0, 0, "skipped"), steps: [] },
    ]);
    expect(
      await inspect({ gh: { api } }, { repo: "cv/pit", id: 7, steps: "^(Build|Test)" }),
    ).toEqual({
      name: "Release",
      status: "completed",
      conclusion: "success",
      headSha: "abc123",
      wallSeconds: 50,
      jobs: [
        {
          name: "linux-x64 addon",
          conclusion: "success",
          seconds: 30,
          steps: [{ name: "Build native addon", seconds: 25 }],
        },
        { name: "suite", conclusion: "skipped", seconds: 0, steps: [] },
      ],
      jobsLimited: false,
    });
    // Both queries project with jq instead of transferring GitHub's full objects.
    expect(api.mock.calls.every(([, args]) => args[0] === "--jq")).toBe(true);
  });

  it("times only jobs without a step pattern", async () => {
    const inspect = await loadWorkflowFunction("ci.inspectTimings");
    const api = github([{ ...step("test", 0, 10), steps: [step("Test", 1, 9)] }]);
    const result = await inspect({ gh: { api } }, { repo: "cv/pit", id: 7 });
    expect(result.jobs).toEqual([{ name: "test", conclusion: "success", seconds: 10 }]);
  });

  it("rejects truncated timings instead of reporting a partial run", async () => {
    const inspect = await loadWorkflowFunction("ci.inspectTimings");
    await expect(
      inspect({ gh: { api: github([], true) } }, { repo: "cv/pit", id: 7 }),
    ).rejects.toThrow("timings were truncated");
  });

  it.each<{ name: string; input: Record<string, unknown>; error: string }>([
    {
      name: "a malformed repository",
      input: { repo: "not a repo", id: 7 },
      error: "repo must be owner/name",
    },
    {
      name: "a fractional run ID",
      input: { repo: "cv/pit", id: 1.5 },
      error: "id must be a positive integer",
    },
  ])("rejects $name before querying GitHub", async ({ input, error }) => {
    const inspect = await loadWorkflowFunction("ci.inspectTimings");
    const api = vi.fn();
    await expect(inspect({ gh: { api } }, input)).rejects.toThrow(error);
    expect(api).not.toHaveBeenCalled();
  });
});
