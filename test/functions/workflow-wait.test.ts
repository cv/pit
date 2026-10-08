import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadWorkflowFunction, processResult } from "../helpers/workflow-function.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const response = (status: string, conclusion = "", jobs: unknown[] = []) =>
  processResult({
    stdout: JSON.stringify({
      status,
      conclusion,
      url: "https://example.invalid/runs/42",
      jobs,
    }),
  });

describe("ci.waitForRun behavior", () => {
  it("waits before the first request, polls at the requested interval, and stops on completion", async () => {
    const wait = await loadWorkflowFunction("ci.waitForRun");
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
      const wait = await loadWorkflowFunction("ci.waitForRun");
      const runView = vi.fn().mockResolvedValue(response("completed", conclusion));
      await expect(
        wait({ gh: { runView } }, { id: 42, repo: "cv/pit", initialDelayMs: 0 }),
      ).rejects.toThrow(conclusion || "no conclusion");
      expect(runView).toHaveBeenCalledOnce();
    },
  );

  it("returns an unsuccessful outcome when the caller explicitly suppresses raising", async () => {
    const wait = await loadWorkflowFunction("ci.waitForRun");
    const runView = vi.fn().mockResolvedValue(response("completed", "failure"));
    expect(
      await wait({ gh: { runView } }, { id: 42, repo: "cv/pit", initialDelayMs: 0, raise: false }),
    ).toMatchObject({ status: "completed", conclusion: "failure" });
  });

  it("stops at its time limit and reports how many requested polls it made", async () => {
    const wait = await loadWorkflowFunction("ci.waitForRun");
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
    // After the 120 s delay, the default 240 s limit leaves room for checks at 120, 150, 180, 210,
    // and 240 s; a sixth would start past the limit.
    expect(await pending).toEqual({
      status: "timed_out",
      id: 42,
      attempts: 5,
      requestedAttempts: 120,
      timeoutMs: 240_000,
      elapsedMs: 240_000,
      lastStatus: "in_progress",
      url: "https://example.invalid/runs/42",
      jobs: [],
    });
    expect(runView).toHaveBeenCalledTimes(5);
    expect(Date.now() - started).toBeLessThanOrEqual(240_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("names the time limit when it cut a failed wait short", async () => {
    const wait = await loadWorkflowFunction("ci.waitForRun");
    const runView = vi.fn().mockResolvedValue(response("in_progress"));
    const failure = wait({ gh: { runView } }, { id: 42, repo: "cv/pit", attempts: 20 }).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await vi.runAllTimersAsync();
    expect(await failure).toContain("did not complete after 9 checks in 240 s");
    expect(await failure).toContain("it stopped at its 240 s time limit with 11 checks unused");
    expect(runView).toHaveBeenCalledTimes(9);
  });

  it("reports the last observed run state and unfinished jobs when a wait times out", async () => {
    const wait = await loadWorkflowFunction("ci.waitForRun");
    const jobs = [
      {
        name: "build",
        status: "completed",
        conclusion: "success",
        url: "https://example.invalid/jobs/1",
      },
      {
        name: "release",
        status: "in_progress",
        conclusion: "",
        url: "https://example.invalid/jobs/2",
      },
    ];
    const runView = vi.fn().mockResolvedValue(response("in_progress", "", jobs));
    const input = { id: 42, repo: "cv/pit", attempts: 2, intervalMs: 1000, initialDelayMs: 0 };
    const returned = wait({ gh: { runView } }, { ...input, raise: false });
    const failure = wait({ gh: { runView } }, input).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await vi.runAllTimersAsync();
    expect(await returned).toMatchObject({
      status: "timed_out",
      lastStatus: "in_progress",
      url: "https://example.invalid/runs/42",
      jobs,
    });
    expect(await failure).toContain("last status in_progress, unfinished jobs: release");
    expect(await failure).not.toContain("build");
  });

  it("fails rather than reporting success when the requested attempts are exhausted", async () => {
    const wait = await loadWorkflowFunction("ci.waitForRun");
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
