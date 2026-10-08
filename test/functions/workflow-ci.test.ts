import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadWorkflowFunction, processResult } from "../helpers/workflow-function.js";

const sha = "abcdef0".padEnd(40, "1");
const run = (databaseId: number, name = "CI", headSha = sha) => ({
  databaseId,
  name,
  headSha,
  status: "completed",
  conclusion: "success",
  url: `https://example.com/runs/${databaseId}`,
});

// Applies GitHub's workflow filter and newest-first search window, like `gh run list`.
const githubRunList = (runs: ReturnType<typeof run>[]) =>
  vi.fn(async (options: { workflow?: string; limit: number; json?: string[] }) =>
    processResult({
      stdout: JSON.stringify(
        runs
          .filter((entry) => !options.workflow || entry.name === options.workflow)
          .slice(0, options.limit),
      ),
    }),
  );

describe("ci.findRun", () => {
  it("asks GitHub for one workflow so other workflows cannot fill the search window", async () => {
    const find = await loadWorkflowFunction("ci.findRun");
    const runs = [
      ...Array.from({ length: 25 }, (_, i) => run(100 + i, "Other")),
      run(42),
      run(43, "CI", "1234567"),
    ];
    const runList = githubRunList(runs);
    expect(
      await find({ gh: { runList } }, { repo: "cv/pit", sha: " ABCDEF0 ", runName: "CI" }),
    ).toMatchObject({
      found: true,
      matches: [{ id: 42, name: "CI", headSha: sha }],
      truncated: false,
      searchLimited: false,
    });
    expect(runList.mock.calls[0]?.[0]).toMatchObject({
      repo: "cv/pit",
      limit: 20,
      workflow: "CI",
      json: expect.arrayContaining([
        "databaseId",
        "headSha",
        "name",
        "status",
        "conclusion",
        "url",
      ]),
      raise: true,
    });
    expect(runList.mock.calls[0]?.[0]?.json).toHaveLength(6);
    expect(runList.mock.calls[0]?.[0]).not.toHaveProperty("commit");
  });

  it("uses server-side commit filtering for full SHAs and reports both bounds", async () => {
    const find = await loadWorkflowFunction("ci.findRun");
    const runList = vi
      .fn()
      .mockResolvedValue(
        processResult({ stdout: JSON.stringify(Array.from({ length: 6 }, (_, i) => run(i))) }),
      );
    const result = await find({ gh: { runList } }, { repo: "cv/pit", sha, limit: 6 });
    expect(result).toMatchObject({ found: true, truncated: true, searchLimited: true });
    expect(result.matches).toHaveLength(5);
    expect(runList.mock.calls[0]?.[0]).toHaveProperty("commit", sha);
    expect(runList.mock.calls[0]?.[0]).not.toHaveProperty("workflow");
  });

  it.each<{ name: string; input: Record<string, unknown>; error: string }>([
    { name: "invalid SHA", input: { sha: "not-a-sha" }, error: "hexadecimal" },
    { name: "fractional limit", input: { limit: 1.5 }, error: "integer" },
    { name: "NaN limit", input: { limit: Number.NaN }, error: "integer" },
    { name: "infinite limit", input: { limit: Number.POSITIVE_INFINITY }, error: "integer" },
  ])("rejects $name before querying GitHub", async ({ input, error }) => {
    const find = await loadWorkflowFunction("ci.findRun");
    const runList = vi.fn();
    await expect(find({ gh: { runList } }, { repo: "cv/pit", sha, ...input })).rejects.toThrow(
      error,
    );
    expect(runList).not.toHaveBeenCalled();
  });

  it("distinguishes no matches from a transport-truncated JSON response", async () => {
    const find = await loadWorkflowFunction("ci.findRun");
    const runList = vi
      .fn()
      .mockResolvedValueOnce(processResult({ stdout: "[]" }))
      .mockResolvedValueOnce(processResult({ stdout: "[", truncated: true }));
    expect(await find({ gh: { runList } }, { repo: "cv/pit", sha })).toEqual({
      found: false,
      matches: [],
      truncated: false,
      searchLimited: false,
    });
    await expect(find({ gh: { runList } }, { repo: "cv/pit", sha })).rejects.toThrow(
      "run list was truncated",
    );
  });
});

describe("ci.waitForRun", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // Each status check takes 20 s, so the 30 s interval plus the check must fit the limit.
  const slowRunView = () =>
    vi.fn(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve(
                processResult({
                  stdout: JSON.stringify({
                    status: "in_progress",
                    url: "url",
                    jobs: [{ name: "build", status: "in_progress", conclusion: "", url: "job" }],
                  }),
                }),
              ),
            20_000,
          ),
        ),
    );

  it("stops at its time limit when status checks are slow", async () => {
    const wait = await loadWorkflowFunction("ci.waitForRun");
    const runView = slowRunView();
    const started = Date.now();
    const pending = wait(
      { gh: { runView } },
      { id: 42, repo: "cv/pit", attempts: 120, intervalMs: 30_000, raise: false },
    );
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({
      status: "timed_out",
      attempts: 3,
      requestedAttempts: 120,
      timeoutMs: 240_000,
      lastStatus: "in_progress",
    });
    expect(Date.now() - started).toBeLessThanOrEqual(240_000);
  });

  it("names the time limit when it raises", async () => {
    const wait = await loadWorkflowFunction("ci.waitForRun");
    const failure = wait(
      { gh: { runView: slowRunView() } },
      { id: 42, repo: "cv/pit", attempts: 120, intervalMs: 30_000, timeoutMs: 180_000 },
    ).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await vi.runAllTimersAsync();
    expect(await failure).toMatch(
      /did not complete after 1 checks in 140 s; it stopped at its 180 s time limit with 119 checks unused; last status in_progress, unfinished jobs: build/,
    );
  });
});

describe("ci.waitForCommit composition", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("retries discovery before waiting on the exact selected run", async () => {
    const wait = await loadWorkflowFunction("ci.waitForCommit");
    const match = {
      id: 42,
      headSha: sha,
      name: "CI",
      status: "completed",
      conclusion: "success",
      url: "url",
    };
    const findRun = vi
      .fn()
      .mockResolvedValueOnce({ found: false, matches: [] })
      .mockResolvedValueOnce({ found: true, matches: [match] });
    const waitForRun = vi.fn().mockResolvedValue({ status: "completed" });
    const pending = wait(
      { ci: { findRun, waitForRun } },
      {
        repo: "cv/pit",
        sha,
        runName: "CI",
        discoveryIntervalMs: 1000,
        attempts: 2,
        raise: false,
      },
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(findRun).toHaveBeenCalledOnce();
    expect(waitForRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ match, run: { status: "completed" } });
    expect(findRun).toHaveBeenLastCalledWith(
      expect.objectContaining({ repo: "cv/pit", sha, runName: "CI" }),
    );
    expect(waitForRun).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        id: 42,
        repo: "cv/pit",
        attempts: 2,
        initialDelayMs: 0,
        raise: false,
      }),
    );
    // Discovery waited 1 s, so the run's wait gets the rest of the 240 s default.
    expect(waitForRun.mock.calls[0]?.[0]?.timeoutMs).toBe(239_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  // Live acceptance found discovery taking 57 s against a 20 s limit.
  it("stops looking for a run at its time limit", async () => {
    const wait = await loadWorkflowFunction("ci.waitForCommit");
    const findRun = vi.fn().mockResolvedValue({ found: false, matches: [] });
    const waitForRun = vi.fn();
    const pending = wait(
      { ci: { findRun, waitForRun } },
      {
        repo: "cv/pit",
        sha,
        runName: "CI",
        discoveryAttempts: 12,
        discoveryIntervalMs: 5000,
        timeoutMs: 12000,
      },
    );
    const settled = pending.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await settled).toBe(
      `No "CI" GitHub Actions run found for ${sha} before its 12 s time limit`,
    );
    // Lookups at 0, 5, and 10 s; a fourth at 15 s would overrun the 12 s limit.
    expect(findRun).toHaveBeenCalledTimes(3);
    expect(waitForRun).not.toHaveBeenCalled();
  });
  it("stops discovery at once when GitHub rejects the workflow filter", async () => {
    const find = await loadWorkflowFunction("ci.findRun");
    const wait = await loadWorkflowFunction("ci.waitForCommit");
    const runList = vi
      .fn()
      .mockRejectedValue(new Error("could not find any workflows named NoSuchWorkflow"));
    const waitForRun = vi.fn();
    await expect(
      wait(
        {
          ci: {
            findRun: (input: Record<string, unknown>) => find({ gh: { runList } }, input),
            waitForRun,
          },
        },
        { repo: "cv/pit", sha, runName: "NoSuchWorkflow", discoveryAttempts: 3 },
      ),
    ).rejects.toThrow("could not find any workflows named NoSuchWorkflow");
    expect(runList).toHaveBeenCalledOnce();
    expect(waitForRun).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not poll an unrelated run when discovery is exhausted", async () => {
    const wait = await loadWorkflowFunction("ci.waitForCommit");
    const findRun = vi.fn().mockResolvedValue({ found: false, matches: [] });
    const waitForRun = vi.fn();
    await expect(
      wait(
        { ci: { findRun, waitForRun } },
        {
          repo: "cv/pit",
          sha,
          runName: "CI",
          discoveryAttempts: 1,
        },
      ),
    ).rejects.toThrow('No "CI" GitHub Actions run found');
    expect(waitForRun).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("composes real discovery with waiting when other workflows ran more recently", async () => {
    const find = await loadWorkflowFunction("ci.findRun");
    const wait = await loadWorkflowFunction("ci.waitForCommit");
    const runs = [...Array.from({ length: 25 }, (_, i) => run(100 + i, "Other")), run(42)];
    const runList = githubRunList(runs);
    const waitForRun = vi.fn().mockResolvedValue({ status: "completed" });
    await wait(
      {
        ci: {
          findRun: (input: Record<string, unknown>) => find({ gh: { runList } }, input),
          waitForRun,
        },
      },
      { repo: "cv/pit", sha, runName: "CI" },
    );
    expect(waitForRun).toHaveBeenCalledWith(expect.objectContaining({ id: 42, initialDelayMs: 0 }));
  });
});
