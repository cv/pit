import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadWorkflowFunction, processResult } from "../helpers/workflow-function.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const check = (name: string, status: string, conclusion = "") => ({
  __typename: "CheckRun",
  name,
  status,
  conclusion,
});
const statusContext = (name: string, state: string) => ({
  __typename: "StatusContext",
  context: name,
  state,
});
const pullRequest = (rollup: unknown[] | null, mergeStateStatus = "BLOCKED") =>
  processResult({
    stdout: JSON.stringify({
      state: "OPEN",
      url: "https://example.invalid/pull/7",
      headRefOid: "abc123",
      mergeStateStatus,
      statusCheckRollup: rollup,
    }),
  });

describe("waitForGitHubPullRequestChecks", () => {
  it("polls until every check passes and reports the merge state", async () => {
    const wait = await loadWorkflowFunction("waitForGitHubPullRequestChecks");
    const prView = vi
      .fn()
      .mockResolvedValueOnce(
        pullRequest([check("test", "IN_PROGRESS"), statusContext("legacy", "PENDING")]),
      )
      .mockResolvedValue(
        pullRequest(
          [
            check("test", "COMPLETED", "SUCCESS"),
            check("lint", "COMPLETED", "SKIPPED"),
            statusContext("legacy", "SUCCESS"),
          ],
          "CLEAN",
        ),
      );
    const pending = wait({ gh: { prView } }, { number: 7, repo: "cv/pit", intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({
      number: 7,
      outcome: "passed",
      attempt: 2,
      headSha: "abc123",
      mergeStateStatus: "CLEAN",
      checks: {
        total: 3,
        passed: 3,
        failed: { names: [], omitted: 0 },
        pending: { names: [], omitted: 0 },
      },
    });
    expect(prView).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ repo: "cv/pit", raise: true }),
    );
  });

  it("asks for the current repository when no repo is given", async () => {
    const wait = await loadWorkflowFunction("waitForGitHubPullRequestChecks");
    const prView = vi.fn().mockResolvedValue(pullRequest([check("test", "COMPLETED", "SUCCESS")]));
    await wait({ gh: { prView } }, { number: 7 });
    expect(prView.mock.calls[0]?.[1]).not.toHaveProperty("repo");
  });

  const failingRollup = () =>
    pullRequest([
      check("test", "COMPLETED", "FAILURE"),
      check("slow", "IN_PROGRESS"),
      statusContext("legacy", "ERROR"),
    ]);

  it("raises at failed checks while others are still pending", async () => {
    const wait = await loadWorkflowFunction("waitForGitHubPullRequestChecks");
    const prView = vi.fn().mockResolvedValue(failingRollup());
    await expect(wait({ gh: { prView } }, { number: 7 })).rejects.toThrow(
      "has failed checks: test (FAILURE), legacy (ERROR)",
    );
    expect(prView).toHaveBeenCalledOnce();
  });

  it("returns failed and pending checks when raising is suppressed", async () => {
    const wait = await loadWorkflowFunction("waitForGitHubPullRequestChecks");
    const prView = vi.fn().mockResolvedValue(failingRollup());
    expect(await wait({ gh: { prView } }, { number: 7, raise: false })).toMatchObject({
      outcome: "failed",
      checks: {
        failed: { names: ["test (FAILURE)", "legacy (ERROR)"] },
        pending: { names: ["slow"] },
      },
    });
    expect(prView).toHaveBeenCalledOnce();
  });

  it("explains a timeout when no checks were reported", async () => {
    const wait = await loadWorkflowFunction("waitForGitHubPullRequestChecks");
    const prView = vi.fn().mockResolvedValue(pullRequest(null));
    const input = { number: 7, attempts: 3, intervalMs: 1000 };
    const returned = wait({ gh: { prView } }, { ...input, raise: false });
    const failure = wait({ gh: { prView } }, input).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await vi.runAllTimersAsync();
    expect(await returned).toMatchObject({
      outcome: "timed_out",
      attempt: 3,
      note: "no checks were reported",
    });
    expect(await failure).toContain("did not settle after 3 polls: no checks were reported");
    expect(prView).toHaveBeenCalledTimes(6);
  });

  it("keeps the whole wait inside the polling budget", async () => {
    const wait = await loadWorkflowFunction("waitForGitHubPullRequestChecks");
    const prView = vi.fn().mockResolvedValue(pullRequest([check("test", "QUEUED")]));
    const started = Date.now();
    const pending = wait(
      { gh: { prView } },
      { number: 7, attempts: 120, intervalMs: 30_000, initialDelayMs: 120_000, raise: false },
    );
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({
      outcome: "timed_out",
      attempt: 6,
      requestedAttempts: 120,
      checks: { pending: { names: ["test"] } },
    });
    expect(prView).toHaveBeenCalledTimes(6);
    expect(Date.now() - started).toBeLessThan(300_000);
  });

  it.each<{ name: string; input: Record<string, unknown> }>([
    { name: "zero PR number", input: { number: 0 } },
    { name: "fractional PR number", input: { number: 1.5 } },
    { name: "zero attempts", input: { number: 7, attempts: 0 } },
    { name: "short interval", input: { number: 7, intervalMs: 999 } },
    { name: "long initial delay", input: { number: 7, initialDelayMs: 120_001 } },
    { name: "malformed repository", input: { number: 7, repo: "not a repo" } },
  ])("rejects $name before querying GitHub", async ({ input }) => {
    const wait = await loadWorkflowFunction("waitForGitHubPullRequestChecks");
    const prView = vi.fn();
    await expect(wait({ gh: { prView } }, input)).rejects.toThrow();
    expect(prView).not.toHaveBeenCalled();
  });
});
