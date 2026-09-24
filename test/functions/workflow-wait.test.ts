import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadWorkflowFunction, processResult } from "../helpers/workflow-function.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const response = (status: string, conclusion = "") =>
  processResult({
    stdout: JSON.stringify({
      status,
      conclusion,
      url: "https://example.invalid/runs/42",
      jobs: [],
    }),
  });

describe("waitForGitHubRun behavior", () => {
  it("waits before the first request, polls at the requested interval, and stops on completion", async () => {
    const wait = await loadWorkflowFunction("waitForGitHubRun");
    const runView = vi
      .fn()
      .mockResolvedValueOnce(response("in_progress"))
      .mockResolvedValue(response("completed", "success"));
    const pending = wait({ gh: { runView } }, { id: 42, repo: "cv/pit", intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(119_999);
    expect(runView).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runView).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(999);
    expect(runView).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ status: "completed", conclusion: "success", attempt: 2 });
    expect(runView).toHaveBeenLastCalledWith(42, expect.objectContaining({ repo: "cv/pit" }));
    const calls = runView.mock.calls.length;
    await vi.runAllTimersAsync();
    expect(runView).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["failure", "cancelled", ""])(
    "rejects completed %s outcomes by default",
    async (conclusion) => {
      const wait = await loadWorkflowFunction("waitForGitHubRun");
      const runView = vi.fn().mockResolvedValue(response("completed", conclusion));
      await expect(
        wait({ gh: { runView } }, { id: 42, repo: "cv/pit", initialDelayMs: 0 }),
      ).rejects.toThrow(conclusion || "no conclusion");
      expect(runView).toHaveBeenCalledOnce();
    },
  );

  it("returns an unsuccessful outcome when the caller explicitly suppresses raising", async () => {
    const wait = await loadWorkflowFunction("waitForGitHubRun");
    const runView = vi.fn().mockResolvedValue(response("completed", "failure"));
    expect(
      await wait({ gh: { runView } }, { id: 42, repo: "cv/pit", initialDelayMs: 0, raise: false }),
    ).toMatchObject({ status: "completed", conclusion: "failure" });
  });

  it("stays within the tool's time budget and reports how many requested polls fit", async () => {
    const wait = await loadWorkflowFunction("waitForGitHubRun");
    const runView = vi.fn().mockResolvedValue(response("in_progress"));
    const started = Date.now();
    const pending = wait(
      { gh: { runView } },
      {
        id: 42,
        repo: "cv/pit",
        attempts: 120,
        intervalMs: 30_000,
        initialDelayMs: 120_000,
        raise: false,
      },
    );
    await vi.runAllTimersAsync();
    // After the 120 s delay, 165 s of budget fits the first check and five 30 s intervals.
    expect(await pending).toEqual({
      status: "timed_out",
      id: 42,
      attempts: 6,
      requestedAttempts: 120,
    });
    expect(runView).toHaveBeenCalledTimes(6);
    expect(Date.now() - started).toBeLessThan(300_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("names the polling budget when it cut a failed wait short", async () => {
    const wait = await loadWorkflowFunction("waitForGitHubRun");
    const runView = vi.fn().mockResolvedValue(response("in_progress"));
    const failure = wait({ gh: { runView } }, { id: 42, repo: "cv/pit", attempts: 20 }).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await vi.runAllTimersAsync();
    expect(await failure).toContain("did not complete after 12 checks");
    expect(await failure).toContain("20 were requested, but only 12 fit the 285 s polling budget");
    expect(runView).toHaveBeenCalledTimes(12);
  });

  it("fails rather than reporting success when the requested attempts are exhausted", async () => {
    const wait = await loadWorkflowFunction("waitForGitHubRun");
    const runView = vi.fn().mockResolvedValue(response("in_progress"));
    const pending = wait(
      { gh: { runView } },
      { id: 42, repo: "cv/pit", attempts: 2, intervalMs: 1000, initialDelayMs: 0 },
    );
    const rejected = pending.then(
      () => false,
      () => true,
    );
    await vi.runAllTimersAsync();
    expect(await rejected).toBe(true);
    expect(runView).toHaveBeenCalledTimes(2);
  });
});
