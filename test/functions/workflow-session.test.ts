import { describe, expect, it, vi } from "vitest";

import { loadWorkflowFunction } from "../helpers/workflow-function.js";

const call = (id: string, label: string) => ({
  id,
  label,
  programs: [],
  shellExec: false,
  promiseAll: false,
  workspaceBatch: false,
});
const failure = (id: string, error: string) => ({ id, error, functionPath: [], failureKind: null });
const page = (events: unknown[] = [], hasMore = false, nextLine = 0) => ({
  events,
  hasMore,
  nextLine,
});

describe("sessions.analyze", () => {
  it.each<{ name: string; label: string; error: string; category: string; workflow: number }>([
    {
      name: "expected failure takes precedence",
      label: "Expect failure: anchor",
      error: "Anchor mismatch",
      category: "expected",
      workflow: 0,
    },
    {
      name: "stale anchor",
      label: "Edit file",
      error: "Anchor mismatch",
      category: "anchor",
      workflow: 1,
    },
    {
      name: "stale revision",
      label: "Edit file",
      error: "Revision mismatch",
      category: "revision",
      workflow: 1,
    },
    {
      name: "TypeScript validation",
      label: "Run tests",
      error: "TypeScript validation failed",
      category: "typescript",
      workflow: 1,
    },
    {
      name: "validation gate",
      label: "Run tests",
      error: 'Function "delivery.validate" failed: failure',
      category: "gate",
      workflow: 0,
    },
    {
      name: "ordinary command",
      label: "Inspect repository",
      error: "Command failed",
      category: "command",
      workflow: 1,
    },
    {
      name: "logic failure",
      label: "Analyze file",
      error: "Unexpected result",
      category: "logic",
      workflow: 1,
    },
  ])("classifies $name in TypeScript", async ({ label, error, category, workflow }) => {
    const analyze = await loadWorkflowFunction("sessions.analyze");
    const readEvents = vi
      .fn()
      .mockResolvedValue(page([{ calls: [call("id", label)], failure: failure("id", error) }]));
    const get = vi.fn();
    expect(
      await analyze({ context: { get }, sessions: { readEvents } }, { file: "/session.jsonl" }),
    ).toMatchObject({
      toolCalls: 1,
      failures: 1,
      failureRatePercent: 100,
      workflowFailures: workflow,
      categories: { [category]: 1 },
      recentFailureExamples: [{ label, error, category }],
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("correlates calls across empty pages and bounds examples without losing counts", async () => {
    const analyze = await loadWorkflowFunction("sessions.analyze");
    const readEvents = vi
      .fn()
      .mockResolvedValueOnce(
        page(
          [
            {
              calls: [
                {
                  ...call("id", "__proto__"),
                  programs: ["node", "node"],
                  shellExec: true,
                  promiseAll: true,
                  workspaceBatch: true,
                },
              ],
              failure: null,
            },
          ],
          true,
          200,
        ),
      )
      .mockResolvedValueOnce(page([], true, 400))
      .mockResolvedValueOnce(
        page(
          [
            { calls: [], failure: failure("unknown", "ignore uncorrelated result") },
            { calls: [], failure: failure("id", "Anchor mismatch") },
            {
              calls: [],
              failure: {
                ...failure("id", "Revision mismatch"),
                functionPath: ["outer", "inner"],
                failureKind: "command",
              },
            },
          ],
          false,
          600,
        ),
      );
    const get = vi.fn().mockResolvedValue({ sessionFile: "/current.jsonl" });
    const result = await analyze({ context: { get }, sessions: { readEvents } }, { examples: 1 });
    expect(result).toMatchObject({
      file: "/current.jsonl",
      toolCalls: 1,
      failures: 2,
      workflowFailures: 2,
      categories: { anchor: 1, revision: 1 },
      execFilePrograms: { node: 2 },
      shellExecCalls: 1,
      promiseAllCalls: 1,
      workspaceBatchCalls: 1,
      repeatedWorkflowFailureLabels: [["__proto__", 2]],
      recentFailureExamples: [
        { error: "Revision mismatch", functionPath: ["outer", "inner"], failureKind: "command" },
      ],
    });
    expect(result.recentFailureExamples).toHaveLength(1);
    expect(readEvents.mock.calls.map(([input]) => input.afterLine)).toEqual([0, 200, 400]);
    expect(result.recommendations).toContain("Split workflows that repeat the same failing label.");
  });

  it("returns a complete zero-count report for an empty session", async () => {
    const analyze = await loadWorkflowFunction("sessions.analyze");
    expect(
      await analyze({
        context: { get: async () => ({ sessionFile: "/empty" }) },
        sessions: { readEvents: async () => page() },
      }),
    ).toMatchObject({
      toolCalls: 0,
      failures: 0,
      failureRatePercent: 0,
      workflowFailureRatePercent: 0,
      recommendations: ["No recurring workflow failure needs action."],
    });
  });

  it("rejects a non-advancing page cursor", async () => {
    const analyze = await loadWorkflowFunction("sessions.analyze");
    await expect(
      analyze(
        { context: { get: vi.fn() }, sessions: { readEvents: async () => page([], true, 0) } },
        { file: "/session" },
      ),
    ).rejects.toThrow("cursor did not advance");
  });

  it("refuses an incomplete audit at the session line budget", async () => {
    const analyze = await loadWorkflowFunction("sessions.analyze");
    const readEvents = vi.fn(async ({ afterLine }: { afterLine: number }) =>
      page([], true, afterLine + 200),
    );
    await expect(
      analyze({ context: { get: vi.fn() }, sessions: { readEvents } }, { file: "/session" }),
    ).rejects.toThrow("100000 lines");
    const cursors = readEvents.mock.calls.map(([input]) => input.afterLine);
    expect(Math.max(...cursors)).toBeLessThan(100_000);
  });

  it("propagates projection failure rather than returning earlier partial counts", async () => {
    const analyze = await loadWorkflowFunction("sessions.analyze");
    const readEvents = vi
      .fn()
      .mockResolvedValueOnce(page([], true, 200))
      .mockRejectedValueOnce(new Error("jq output was truncated"));
    await expect(
      analyze({ context: { get: vi.fn() }, sessions: { readEvents } }, { file: "/session" }),
    ).rejects.toThrow("truncated");
  });
});

const audit = (file: string) => ({
  file,
  toolCalls: 4,
  failures: 2,
  workflowFailures: 1,
  gateFailures: 1,
  expectedFailures: 0,
  categories: { logic: 1, gate: 1 },
  execFilePrograms: { node: 2 },
  repeatedWorkflowFailureLabels: [["repeat", 1]],
  recommendations: ["Action needed"],
});

describe("sessions.analyzeRecent", () => {
  it("selects newest filenames before limiting and escapes directory glob syntax", async () => {
    const analyzeRecent = await loadWorkflowFunction("sessions.analyzeRecent");
    const directory = "/sessions/[project](name)";
    const glob = vi.fn().mockResolvedValue({
      entries: [`${directory}/a.jsonl`, `${directory}/c\nnew.jsonl`, `${directory}/b.jsonl`],
      truncated: false,
    });
    const analyzeSession = vi.fn(async ({ file }: { file: string }) => audit(file));
    const result = await analyzeRecent(
      {
        context: { get: async () => ({ sessionFile: `${directory}/current.jsonl` }) },
        workspace: { glob },
        sessions: { analyze: analyzeSession },
      },
      { limit: 2, examples: 3 },
    );
    expect(glob).toHaveBeenCalledWith("/sessions/\\[project\\]\\(name\\)/*.jsonl", {
      onlyFiles: true,
      dot: true,
      limit: 10000,
    });
    expect(analyzeSession.mock.calls.map(([input]) => input)).toEqual([
      { file: `${directory}/c\nnew.jsonl`, examples: 3 },
      { file: `${directory}/b.jsonl`, examples: 3 },
    ]);
    expect(result).toMatchObject({
      sessions: 2,
      toolCalls: 8,
      failures: 4,
      workflowFailures: 2,
      workflowFailureRatePercent: 25,
      categories: { logic: 2, gate: 2 },
      execFilePrograms: { node: 4 },
      repeatedWorkflowFailureLabels: [["repeat", 2]],
    });
  });

  it("bounds concurrent audits while returning every selected session", async () => {
    const analyzeRecent = await loadWorkflowFunction("sessions.analyzeRecent");
    const releases: Array<() => void> = [];
    const completed: string[] = [];
    let active = 0;
    let peak = 0;
    const analyzeSession = ({ file }: { file: string }) => {
      active++;
      peak = Math.max(peak, active);
      return new Promise((resolve) =>
        releases.push(() => {
          active--;
          completed.push(file);
          resolve(audit(file));
        }),
      );
    };
    const files = Array.from({ length: 9 }, (_, i) => `/sessions/${i}.jsonl`);
    const pending = analyzeRecent({
      context: { get: async () => ({ sessionFile: "/sessions/current.jsonl" }) },
      workspace: { glob: async () => ({ entries: files, truncated: false }) },
      sessions: { analyze: analyzeSession },
    });
    while (completed.length < files.length) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
      releases.splice(0).forEach((release) => release());
    }
    expect(await pending).toMatchObject({ sessions: files.length });
    expect(completed.sort()).toEqual([...files].sort());
    expect(peak).toBeLessThanOrEqual(4);
    expect(active).toBe(0);
  });

  it("refuses truncated discovery before starting audits", async () => {
    const analyzeRecent = await loadWorkflowFunction("sessions.analyzeRecent");
    const analyzeSession = vi.fn();
    await expect(
      analyzeRecent({
        context: { get: async () => ({ sessionFile: "/sessions/current" }) },
        workspace: { glob: async () => ({ entries: [], truncated: true }) },
        sessions: { analyze: analyzeSession },
      }),
    ).rejects.toThrow("incomplete selection");
    expect(analyzeSession).not.toHaveBeenCalled();
  });

  it("does not combine a clean-session recommendation with actionable recommendations", async () => {
    const analyzeRecent = await loadWorkflowFunction("sessions.analyzeRecent");
    const analyzeSession = vi
      .fn()
      .mockResolvedValueOnce({
        ...audit("a"),
        recommendations: ["No recurring workflow failure needs action."],
      })
      .mockResolvedValueOnce(audit("b"));
    expect(
      await analyzeRecent({
        context: { get: async () => ({ sessionFile: "/sessions/current" }) },
        workspace: { glob: async () => ({ entries: ["a", "b"], truncated: false }) },
        sessions: { analyze: analyzeSession },
      }),
    ).toMatchObject({ recommendations: ["Action needed"] });
  });
});
