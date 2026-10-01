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
const usage = (input: number, cacheRead = 0, cost = 0) => ({
  input,
  output: 5,
  cacheRead,
  cacheWrite: 10,
  cost,
});
const edit = (
  operation: string,
  targets: string[],
  extra: {
    covers?: string[];
    action?: string;
    tokensFreed?: number;
    reprefillTokens?: number;
  } = {},
) => ({
  operation,
  targets,
  covers: [],
  action: null,
  tokensFreed: 0,
  reprefillTokens: 0,
  ...extra,
});
const contextEvent = (context: Record<string, unknown>, calls: unknown[] = []) => ({
  calls,
  failure: null,
  context,
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
      context: {
        requests: 0,
        compactions: { total: 0, modelRequested: 0 },
        edits: { total: 0, byOperation: {} },
        notices: { shown: 0, followed: 0 },
        churn: { inspectedRemovedEntries: 0, reeditedEntries: 0 },
      },
      recommendations: ["No recurring workflow failure needs action."],
    });
  });

  it.each<{ name: string; turns: number; operation: string; followed: number }>([
    { name: "an elide in the window's last turn", turns: 3, operation: "elide", followed: 1 },
    { name: "a summarize after the window", turns: 4, operation: "summarize", followed: 0 },
    { name: "a note, which frees no context", turns: 1, operation: "note", followed: 0 },
  ])("scores a pressure notice followed by $name", async ({ turns, operation, followed }) => {
    const analyze = await loadWorkflowFunction("sessions.analyze");
    const events = [
      contextEvent({ notice: { level: 50, percent: 52, tokens: 520, contextWindow: 1000 } }),
      ...Array.from({ length: turns }, () => contextEvent({ request: usage(10) })),
      contextEvent({ edits: [edit(operation, ["a"])] }),
    ];
    const result = await analyze(
      { context: { get: vi.fn() }, sessions: { readEvents: async () => page(events) } },
      { file: "/session" },
    );
    expect(result).toMatchObject({
      context: { notices: { shown: 1, byLevel: { "50%": 1 }, followed, followWindowTurns: 3 } },
    });
  });

  it("totals usage, compactions, edits, and churn in session order", async () => {
    const analyze = await loadWorkflowFunction("sessions.analyze");
    const readEvents = vi
      .fn()
      .mockResolvedValueOnce(
        page(
          [
            contextEvent({ request: usage(10, 980, 0.0001) }),
            contextEvent({
              edits: [
                edit("note", [], { action: "created", tokensFreed: -20, reprefillTokens: 20 }),
                edit("elide", ["a"], { tokensFreed: 400, reprefillTokens: 1000 }),
              ],
            }),
            // Reading an elided entry is churn; reading a visible one is not.
            contextEvent({ request: usage(20, 400, 0.0002) }, [
              { ...call("read", "Inspect"), inspectTargets: ["a", "b"] },
            ]),
          ],
          true,
          200,
        ),
      )
      .mockResolvedValueOnce(
        page([
          contextEvent({
            edits: [edit("summarize", ["c"], { covers: ["a", "c"], tokensFreed: 300 })],
          }),
          contextEvent({ edits: [edit("restore", ["c"], { tokensFreed: -300 })] }),
          { calls: [{ ...call("reread", "Inspect"), inspectTargets: ["c"] }], failure: null },
          contextEvent({
            compaction: {
              tokensBefore: 5000,
              usage: { ...usage(1), cacheWrite: 4000, cost: 0.003 },
            },
          }),
          contextEvent({ sessionCalls: ["compact", "outline", "outline"] }),
        ]),
      );
    const result = await analyze(
      { context: { get: vi.fn() }, sessions: { readEvents } },
      { file: "/session" },
    );
    expect(result).toMatchObject({
      toolCalls: 2,
      context: {
        requests: 2,
        usage: { input: 30, output: 10, cacheRead: 1380, cacheWrite: 20, cost: 0.0003 },
        peakPromptTokens: 1000,
        compactions: {
          total: 1,
          modelRequested: 1,
          tokensBefore: 5000,
          usage: { cacheWrite: 4000, cost: 0.003 },
        },
        edits: {
          total: 4,
          byOperation: { note: 1, elide: 1, summarize: 1, restore: 1 },
          noteActions: { created: 1 },
          tokensFreed: 380,
          reprefillTokens: 1020,
        },
        churn: { inspectedRemovedEntries: 1, reeditedEntries: 1 },
        sessionCalls: { compact: 1, outline: 2 },
      },
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

  it("sums context telemetry across sessions and keeps peaks as maxima", async () => {
    const analyzeRecent = await loadWorkflowFunction("sessions.analyzeRecent");
    const context = (peak: number, operation: string, cost: number) => ({
      requests: 2,
      usage: { input: 1, output: 2, cacheRead: 30, cacheWrite: 4, cost },
      peakPromptTokens: peak,
      compactions: { total: 1, modelRequested: 0, tokensBefore: 900, usage: usage(0) },
      edits: { total: 1, byOperation: { [operation]: 1 }, noteActions: {}, tokensFreed: 50 },
      notices: { shown: 1, byLevel: { "50%": 1 }, followed: 1, followWindowTurns: 3 },
      churn: { inspectedRemovedEntries: 1, reeditedEntries: 0 },
      sessionCalls: { outline: 1 },
    });
    const contexts: Record<string, ReturnType<typeof context>> = {
      a: context(800, "elide", 0.1),
      b: context(300, "summarize", 0.2),
    };
    // An audit without context telemetry, such as c, contributes nothing.
    const analyzeSession = vi.fn(async ({ file }: { file: string }) => ({
      ...audit(file),
      ...(contexts[file] ? { context: contexts[file] } : {}),
    }));
    const result = await analyzeRecent({
      context: { get: async () => ({ sessionFile: "/sessions/current" }) },
      workspace: { glob: async () => ({ entries: ["a", "b", "c"], truncated: false }) },
      sessions: { analyze: analyzeSession },
    });
    expect(result.context).toEqual({
      requests: 4,
      usage: { input: 2, output: 4, cacheRead: 60, cacheWrite: 8, cost: 0.3 },
      peakPromptTokens: 800,
      compactions: {
        total: 2,
        modelRequested: 0,
        tokensBefore: 1800,
        usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 20, cost: 0 },
      },
      edits: {
        total: 2,
        byOperation: { elide: 1, summarize: 1 },
        noteActions: {},
        tokensFreed: 100,
      },
      notices: { shown: 2, byLevel: { "50%": 2 }, followed: 2, followWindowTurns: 3 },
      churn: { inspectedRemovedEntries: 2, reeditedEntries: 0 },
      sessionCalls: { outline: 2 },
    });
    expect(result.perSession).toMatchObject([
      { file: "c", contextEdits: 0, contextNotices: 0, compactions: 0 },
      { file: "b", contextEdits: 1, contextNotices: 1, compactions: 1 },
      { file: "a", contextEdits: 1, contextNotices: 1, compactions: 1 },
    ]);
  });
});
