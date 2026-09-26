import { describe, expect, it, vi } from "vitest";

import { loadWorkflowFunction, processResult } from "../helpers/workflow-function.js";

const step = (number: number, name: string, conclusion = "success") => ({
  number,
  name,
  status: "completed",
  conclusion,
});
const job = (databaseId: number, conclusion = "failure") => ({
  databaseId,
  name: `job ${databaseId}`,
  status: "completed",
  conclusion,
  url: `https://example.invalid/jobs/${databaseId}`,
  steps: [
    step(1, "Set up job"),
    step(9, "Test with coverage", conclusion === "success" ? "success" : "failure"),
    step(10, "Post Check out"),
  ],
});
const runView = (jobs: unknown[], status = "completed") =>
  vi.fn().mockResolvedValue(
    processResult({
      stdout: JSON.stringify({
        name: "CI",
        status,
        conclusion: status === "completed" ? "failure" : "",
        url: "https://example.invalid/runs/42",
        headSha: "abc123",
        jobs,
      }),
    }),
  );
const stamp = (text: string) => `2026-09-24T10:00:00.1234567Z ${text}`;
const failingLog = [
  `\uFEFF${stamp("##[group]Run npm ci")}`,
  stamp("installed"),
  stamp("##[endgroup]"),
  stamp("##[group]Run npm run coverage"),
  ...Array.from({ length: 60 }, (_, index) => stamp(`progress ${index}`)),
  stamp("\u001b[31mFAIL test/a.test.ts > breaks\u001b[39m"),
  stamp("##[error]Process completed with exit code 1."),
  stamp("Post job cleanup."),
  stamp("Cleaning up orphan processes"),
].join("\n");

describe("ci.inspectFailure", () => {
  it("excerpts each failed job up to its last error instead of the cleanup tail", async () => {
    const inspect = await loadWorkflowFunction("ci.inspectFailure");
    const view = runView([job(7), job(8, "success")]);
    const api = vi.fn().mockResolvedValue(processResult({ stdout: failingLog, truncated: true }));
    const result = await inspect(
      { gh: { runView: view, api } },
      { repo: "cv/pit", id: 42, lines: 10 },
    );
    expect(result).toMatchObject({
      id: 42,
      name: "CI",
      status: "completed",
      headSha: "abc123",
      omittedJobs: 0,
    });
    expect(result).not.toHaveProperty("note");
    const failedJobs = result.failedJobs as Array<Record<string, unknown>>;
    expect(failedJobs).toHaveLength(1);
    expect(failedJobs[0]).toMatchObject({
      name: "job 7",
      failedSteps: ["9. Test with coverage (failure)"],
      step: "npm run coverage",
      errors: ["Process completed with exit code 1."],
      logTruncated: true,
    });
    const excerpt = String(failedJobs[0]?.excerpt).split("\n");
    expect(excerpt.at(-1)).toBe("##[error]Process completed with exit code 1.");
    expect(excerpt).toContain("FAIL test/a.test.ts > breaks");
    expect(excerpt).toHaveLength(11);
    expect(excerpt.join("\n")).not.toMatch(/Post job cleanup|2026-09-24T/);
    expect(excerpt.join("\n")).not.toContain("\u001b[");
    expect(view).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ repo: "cv/pit", json: expect.arrayContaining(["jobs"]) }),
    );
    expect(api).toHaveBeenCalledOnce();
    expect(api).toHaveBeenCalledWith(
      "repos/cv/pit/actions/jobs/7/logs",
      [],
      expect.objectContaining({ truncate: "tail" }),
    );
  });

  it("lists failed Vitest tests with their errors and counts failures outside the log window", async () => {
    const inspect = await loadWorkflowFunction("ci.inspectFailure");
    const log = [
      stamp("##[group]Run npm run coverage"),
      stamp(" FAIL  test/a.test.ts > suite > times out"),
      stamp("Error: Test timed out in 15000ms."),
      stamp(" FAIL  test/b.test.ts > compares"),
      stamp("\u001b[31mAssertionError: expected 1 to be 2\u001b[39m"),
      stamp(" FAIL  test/a.test.ts > suite > times out"),
      stamp("      Tests  3 failed | 10 passed (13)"),
      stamp("##[error]Process completed with exit code 1."),
    ].join("\n");
    const api = vi.fn().mockResolvedValue(processResult({ stdout: log, truncated: true }));
    const result = await inspect(
      { gh: { runView: runView([job(7)]), api } },
      { repo: "cv/pit", id: 42 },
    );
    const [failed] = result.failedJobs as Array<Record<string, unknown>>;
    expect(failed).toMatchObject({
      testSummary: "Tests 3 failed | 10 passed (13)",
      testFailures: [
        { test: "test/a.test.ts > suite > times out", error: "Error: Test timed out in 15000ms." },
        { test: "test/b.test.ts > compares", error: "AssertionError: expected 1 to be 2" },
      ],
      // The summary reports a third failure that the fetched window no longer contained.
      testFailuresOmitted: 1,
    });
  });

  it("falls back to the lines before post-job cleanup when no error was logged", async () => {
    const inspect = await loadWorkflowFunction("ci.inspectFailure");
    const log = [
      stamp("##[group]Run ./build.sh"),
      stamp("compiling"),
      stamp("last useful line"),
      stamp("Post job cleanup."),
      stamp("Cleaning up orphan processes"),
    ].join("\n");
    const api = vi.fn().mockResolvedValue(processResult({ stdout: log }));
    const result = await inspect(
      { gh: { runView: runView([job(7)]), api } },
      { repo: "cv/pit", id: 42 },
    );
    const [failed] = result.failedJobs as Array<Record<string, unknown>>;
    expect(failed).toMatchObject({ step: "./build.sh", errors: [], logTruncated: false });
    expect(String(failed?.excerpt).split("\n").at(-1)).toBe("last useful line");
  });

  it("limits inspected jobs and keeps a job whose log is unavailable", async () => {
    const inspect = await loadWorkflowFunction("ci.inspectFailure");
    const api = vi
      .fn()
      .mockResolvedValue(processResult({ code: 1, stderr: "gh: HTTP 410: logs expired" }));
    const result = await inspect(
      { gh: { runView: runView([job(1), job(2), job(3), job(4), job(5)]), api } },
      { repo: "cv/pit", id: 42, jobs: 2 },
    );
    expect(result.omittedJobs).toBe(3);
    expect(result.failedJobs).toHaveLength(2);
    expect((result.failedJobs as Array<Record<string, unknown>>)[0]).toMatchObject({
      failedSteps: ["9. Test with coverage (failure)"],
      excerpt: "",
      logError: expect.stringContaining("logs expired"),
    });
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("labels a run that is still in progress", async () => {
    const inspect = await loadWorkflowFunction("ci.inspectFailure");
    const api = vi.fn().mockResolvedValue(processResult({ stdout: failingLog }));
    const result = await inspect(
      { gh: { runView: runView([job(7)], "in_progress"), api } },
      { repo: "cv/pit", id: 42 },
    );
    expect(result.note).toContain("in_progress");
    expect(result.failedJobs).toHaveLength(1);
  });

  it.each<{ name: string; input: Record<string, unknown> }>([
    { name: "malformed repository", input: { repo: "not a repo", id: 42 } },
    { name: "zero run ID", input: { repo: "cv/pit", id: 0 } },
    { name: "fractional run ID", input: { repo: "cv/pit", id: 1.5 } },
    { name: "lines below 5", input: { repo: "cv/pit", id: 42, lines: 4 } },
    { name: "lines above 200", input: { repo: "cv/pit", id: 42, lines: 201 } },
    { name: "zero jobs", input: { repo: "cv/pit", id: 42, jobs: 0 } },
    { name: "jobs above 10", input: { repo: "cv/pit", id: 42, jobs: 11 } },
  ])("rejects $name before querying GitHub", async ({ input }) => {
    const inspect = await loadWorkflowFunction("ci.inspectFailure");
    const view = vi.fn();
    const api = vi.fn();
    await expect(inspect({ gh: { runView: view, api } }, input)).rejects.toThrow();
    expect(view).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
  });
});
