import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";

import { APPLY_STAGED_EDITS, createApplyEditsHook } from "../../src/durable/context/apply.js";
import { planCollapse } from "../../src/durable/context/collapse.js";
import { planElide, planSummarize } from "../../src/durable/context/edits.js";
import { StagedContextChanges } from "../../src/durable/context/staging.js";
import { readContextView } from "../../src/durable/context/view.js";
import { createPitDurableExtension } from "../../src/durable/index.js";
import { createDurableSessionHandler } from "../../src/durable/session.js";

// Conversation histories built entry by entry, read through a stand-in for a tool's commit.

const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} };

function user(id: number, text: string, kind = "pi.user") {
  return { id, conversationId: 1, kind, model: [{ role: "user", content: text, timestamp: 0 }] };
}

function assistant(id: number, blocks: any[], stopReason = "toolUse") {
  return {
    id,
    conversationId: 1,
    kind: "pi.assistant",
    model: [
      {
        role: "assistant",
        content: blocks,
        api: "faux",
        provider: "faux",
        model: "m",
        usage: USAGE,
        stopReason,
        timestamp: 0,
      },
    ],
  };
}

function call(id: string, name = "typescript") {
  return { type: "toolCall", id, name, arguments: { code: "x".repeat(40) } };
}

function result(
  id: number,
  callId: string,
  text: string,
  options: { isError?: boolean; tool?: string } = {},
) {
  return {
    id,
    conversationId: 1,
    kind: "pi.tool-result",
    model: [
      {
        role: "toolResult",
        toolCallId: callId,
        toolName: options.tool ?? "typescript",
        content: [{ type: "text", text }],
        isError: options.isError === true,
        timestamp: 0,
      },
    ],
  };
}

const BIG = "payload ".repeat(500);

/** A tool API whose commit reads `entries` in pages of two, as Storage pages them. */
function fakeApi(entries: any[], options: { callId?: string; head?: any } = {}) {
  const submitted: any[] = [];
  const tx = {
    latestHeadMarker: async () => options.head,
    scanEntries: async (query: any, limit: number, cursor?: number) => {
      const matching = entries.filter(
        (entry) =>
          (query.minEntryId === undefined || entry.id >= query.minEntryId) &&
          (query.maxEntryId === undefined || entry.id <= query.maxEntryId),
      );
      const start = cursor ?? 0;
      const end = start + Math.min(limit, 2);
      return {
        items: matching.slice(start, end),
        ...(end < matching.length ? { next: end } : {}),
      };
    },
  };
  return {
    submitted,
    api: {
      conversationId: 1,
      callId: options.callId ?? "running",
      commit: async (change: (tx: any) => unknown) => change(tx),
      conversation: async () => ({
        submit: async (draft: unknown) => {
          submitted.push(draft);
          return { id: 99 };
        },
      }),
      snapshot: async () => undefined,
    } as any,
  };
}

async function view(entries: any[], options: { callId?: string; head?: any } = {}) {
  return readContextView(fakeApi(entries, options).api, context, options.callId ?? "running");
}

const HISTORY = [
  user(1, "start"),
  assistant(2, [{ type: "thinking", thinking: "plan" }, call("a"), call("b", "echo")]),
  result(3, "a", BIG),
  result(4, "b", BIG, { isError: true, tool: "echo" }),
  assistant(5, [{ type: "text", text: "halfway" }], "stop"),
  assistant(6, [{ type: "text", text: "lost" }], "aborted"),
  user(7, "host note", "app.note"),
  assistant(8, [call("c")]),
  result(9, "c", BIG),
  assistant(10, [call("running")]),
];

describe("durable context view", () => {
  it("projects roles, protection, and tokens from every page of the active range", async () => {
    const current = await view(HISTORY);
    expect(current.items.map((item) => [item.id, item.role, item.protectedReason])).toEqual([
      ["1", "user", "user message"],
      ["2", "assistant", undefined],
      ["3", "toolResult", undefined],
      ["4", "toolResult", undefined],
      ["5", "assistant", undefined],
      ["7", "custom", "host message"],
      ["8", "assistant", undefined],
      ["9", "toolResult", undefined],
      ["10", "assistant", "current turn"],
    ]);
    expect(current.byId.get("2")?.tools).toEqual(["typescript", "echo"]);
    expect(current.tailId).toBe("10");
  });

  it("starts at the newest head marker and counts images", async () => {
    const head = {
      ...user(20, "[summary]", "pi.compaction"),
      head: 8,
    };
    const image = {
      ...result(9, "c", "chart"),
      model: [
        {
          ...result(9, "c", "chart").model[0],
          content: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
        },
      ],
    };
    const current = await view([...HISTORY.slice(0, 8), image, HISTORY[9], head], { head });
    expect(current.items.map((item) => [item.id, item.role])).toEqual([
      ["20", "summary"],
      ["8", "assistant"],
      ["9", "toolResult"],
      ["10", "assistant"],
    ]);
    expect(current.byId.get("9")?.tokens).toBe(1200);
    expect(current.activeIds.has("3")).toBe(false);
  });

  it("applies the newest edit per target and tracks staged rewrites until applied", async () => {
    const elide = planElide(await view(HISTORY), ["3"]);
    const summary = planSummarize(await view(HISTORY), {
      from: "8",
      to: "9",
      summary: "one call",
    });
    const edited = [
      ...HISTORY,
      {
        id: 11,
        conversationId: 1,
        kind: "pit.context-edit",
        data: { operations: [elide.provenance] },
        edits: elide.edits,
      },
      {
        id: 12,
        conversationId: 1,
        kind: "pit.context-edit",
        data: { operations: [summary.provenance] },
        edits: summary.edits,
      },
      {
        id: 13,
        conversationId: 1,
        kind: "app.rewrite",
        edits: [
          {
            target: 5,
            action: "replace",
            messages: assistant(5, [{ type: "text", text: "redone" }], "stop").model,
          },
        ],
      },
      {
        id: 14,
        conversationId: 1,
        kind: "pit.context-edit-pending",
        data: { operations: [planElide(await view(HISTORY), ["4"]).provenance] },
      },
      {
        id: 15,
        conversationId: 1,
        kind: "pit.context-edit-pending",
        data: { operations: [planElide(await view(HISTORY), ["2"]).provenance] },
      },
      {
        id: 16,
        conversationId: 1,
        kind: "pit.context-edit",
        data: { operations: [], pending: [15] },
      },
    ];
    const current = await view(edited);
    expect(current.byId.get("3")?.state).toBe("elided");
    expect(current.byId.get("5")?.state).toBe("replaced");
    expect(current.byId.get("8")).toMatchObject({ state: "summarized", covers: ["8", "9"] });
    expect(current.byId.has("9")).toBe(false);
    expect([...current.pending]).toEqual([["4", "elide"]]);
  });
});

describe("durable elide and summarize planning", () => {
  it("turns a multi-call entry into one note naming its tools and failures", async () => {
    const plan = planElide(await view(HISTORY), ["2", "3"], "done");
    expect(plan.edits.map((edit) => [edit.target, edit.action])).toEqual([
      [2, "replace"],
      [3, "omit"],
      [4, "omit"],
    ]);
    const note = (plan.edits[0] as any).messages[0].content[0].text;
    expect(note).toMatch(
      /^\[Pit: elided tool calls: typescript, echo · ~\d+\.\dK tokens with their results · 1 failed · reason: done · originals: /,
    );
    expect(plan.provenance.tokensFreed).toBeGreaterThan(1000);
  });

  it.each([
    ["no IDs", [], undefined, /at least one entry ID/],
    [
      "too many IDs",
      Array.from({ length: 201 }, (_, index) => String(index)),
      undefined,
      /at most 200/,
    ],
    ["a long reason", ["3"], "x".repeat(201), /at most 200 characters/],
    ["an entry that contributes nothing", ["6"], undefined, /contributes nothing/],
    ["the running turn", ["10"], undefined, /current turn/],
  ])("refuses to elide %s", async (_name, ids, reason, message) => {
    const current = await view(HISTORY);
    expect(() => planElide(current, ids, reason)).toThrow(message);
  });

  it("refuses entries already rewritten or staged", async () => {
    const elide = planElide(await view(HISTORY), ["3"]);
    const staged = planElide(await view(HISTORY), ["9"]);
    const current = await view([
      ...HISTORY,
      {
        id: 11,
        conversationId: 1,
        kind: "pit.context-edit",
        data: { operations: [elide.provenance] },
        edits: elide.edits,
      },
      {
        id: 12,
        conversationId: 1,
        kind: "pit.context-edit-pending",
        data: { operations: [staged.provenance] },
      },
    ]);
    expect(() => planElide(current, ["3"])).toThrow(/already elided/);
    expect(() => planElide(current, ["9"])).toThrow(/staged rewrite/);
  });

  it("refuses to elide a call whose result belongs to the running turn", async () => {
    const current = await view(HISTORY, { callId: "c" });
    expect(() => planElide(current, ["2"])).not.toThrow();
    expect(() => planElide(current, ["8"])).toThrow(/current turn/);
  });

  it.each([
    ["an unknown start", { from: "99", to: "9" }, /99 is not visible/],
    ["an unknown end", { from: "8", to: "99" }, /99 is not visible/],
    ["a reversed range", { from: "9", to: "8" }, /comes after/],
    ["an empty summary", { from: "8", to: "9", summary: " " }, /must not be empty/],
    [
      "a summary as long as its range",
      { from: "5", to: "5", summary: "x".repeat(400) },
      /must be shorter/,
    ],
    ["a range ending on a call", { from: "8", to: "8" }, /splits tool call c/],
  ])("refuses to summarize %s", async (_name, input, message) => {
    const current = await view(HISTORY);
    expect(() => planSummarize(current, { summary: "short", ...input })).toThrow(message);
  });
});

describe("durable session handler", () => {
  async function handler(entries = HISTORY) {
    const fake = fakeApi(entries);
    return {
      ...fake,
      call: createDurableSessionHandler({
        api: fake.api,
        context,
        contextWindow: 200_000,
        staging: new StagedContextChanges(),
      }),
    };
  }

  it("pages the outline by cursor, role, and tool", async () => {
    const { call: session } = await handler();
    const first = (await session(
      "outline",
      [{ limit: 2, previewChars: 5 }],
      undefined as never,
    )) as any;
    expect(first.entries.map((entry: any) => entry.id)).toEqual(["1", "2"]);
    expect(first).toMatchObject({ nextAfter: "2", omitted: 7, leafId: "10" });
    expect(first.entries[1].preview).toBe("plan …");
    const next = (await session(
      "outline",
      [{ after: "2", tool: "echo" }],
      undefined as never,
    )) as any;
    expect(next.entries.map((entry: any) => entry.id)).toEqual(["4"]);
    await expect(session("outline", [{ after: "6" }], undefined as never)).rejects.toThrow(
      /Cursor 6/,
    );
    await expect(session("outline", [{ roles: ["system"] }], undefined as never)).rejects.toThrow(
      /unknown role "system"/,
    );
  });

  it("inspects entries by state, including ones the context leaves out", async () => {
    const { call: session } = await handler();
    const assistantEntry = (await session("inspectEntry", ["2"], undefined as never)) as any;
    expect(assistantEntry).toMatchObject({
      role: "assistant",
      tool: "typescript, echo",
      state: "original",
    });
    expect(assistantEntry.original.text).toContain("→ typescript");
    await expect(session("inspectEntry", ["6"], undefined as never)).resolves.toMatchObject({
      state: "omitted",
    });
    await expect(session("inspectEntry", ["7"], undefined as never)).resolves.toMatchObject({
      role: "custom",
    });
    await expect(session("inspectEntry", ["abc"], undefined as never)).rejects.toThrow(
      /not in this conversation/,
    );
    const head = { ...user(20, "[summary]", "pi.compaction"), head: 8 };
    const compacted = fakeApi([...HISTORY, head], { head });
    const later = createDurableSessionHandler({
      api: compacted.api,
      context,
      contextWindow: undefined,
      staging: new StagedContextChanges(),
    });
    await expect(later("inspectEntry", ["3"], undefined as never)).resolves.toMatchObject({
      state: "compacted",
    });
    await expect(later("inspectEntry", ["20"], undefined as never)).resolves.toMatchObject({
      role: "summary",
    });
    const bookkeeping = fakeApi([
      ...HISTORY,
      { id: 11, conversationId: 1, kind: "app.data", data: {} },
    ]);
    const reader = createDurableSessionHandler({
      api: bookkeeping.api,
      context,
      contextWindow: undefined,
      staging: new StagedContextChanges(),
    });
    await expect(reader("inspectEntry", ["11"], undefined as never)).rejects.toThrow(
      /contributes no model content/,
    );
    await expect(reader("info", [], undefined as never)).resolves.toMatchObject({
      contextWindow: undefined,
      contextPercent: undefined,
    });
  });

  it("stages rewrites for now or the run's end, writing nothing until the call applies them", async () => {
    const fake = fakeApi(HISTORY);
    const staging = new StagedContextChanges();
    const session = createDurableSessionHandler({
      api: fake.api,
      context,
      contextWindow: 200_000,
      staging,
    });
    const { submitted } = fake;
    await session("elide", [["3"], { when: "now" }], undefined as never);
    await session(
      "summarize",
      [{ from: "8", to: "9", summary: "one call", when: "end" }],
      undefined as never,
    );
    expect(submitted).toEqual([]);
    await expect(session("elide", [["3"]], undefined as never)).rejects.toThrow(
      /already has a staged rewrite/,
    );
    await staging.apply(fake.api, context, 200_000);
    expect(submitted.map((draft) => draft.entry.kind)).toEqual([
      "pit.context-edit",
      "pit.context-edit-pending",
    ]);
    await expect(session("elide", [["4"], { when: "later" }], undefined as never)).rejects.toThrow(
      /must be "now" or "end"/,
    );
  });

  it("reports an empty conversation without a tail", async () => {
    const { call: session } = await handler([]);
    await expect(session("info", [], undefined as never)).resolves.toMatchObject({ leafId: null });
    await expect(session("outline", [], undefined as never)).resolves.toMatchObject({
      leafId: null,
      entries: [],
    });
  });
});

describe("staged rewrites at the end of a run", () => {
  const afterRun = (createApplyEditsHook(undefined).handlers as any).afterRun;

  function runApi(pages: any[][]) {
    return {
      entries: async (_query: unknown, _limit: number, cursor: number | undefined) => {
        const index = cursor ?? 0;
        return { items: pages[index], ...(index + 1 < pages.length ? { next: index + 1 } : {}) };
      },
    };
  }

  it("asks for one task applying every staged entry of the run, across pages", async () => {
    const staged = (id: number) => ({ id, kind: "pit.context-edit-pending" });
    const answer = await afterRun(
      { first: 1, last: 9 },
      runApi([[staged(2), { id: 3, kind: "pi.assistant" }], [staged(5)]]),
      context,
    );
    expect(answer).toEqual({ tasks: [{ task: APPLY_STAGED_EDITS, input: { pending: [2, 5] } }] });
  });

  it("asks for nothing when the run staged nothing", async () => {
    await expect(
      afterRun({ first: 1, last: 2 }, runApi([[{ id: 1, kind: "pi.user" }]]), context),
    ).resolves.toBeUndefined();
  });

  it("asks for the collapse after every answered run, from the run's first entry", async () => {
    const collapse = (createApplyEditsHook({ keepRuns: 1, minTokens: 0 }).handlers as any).afterRun;
    await expect(
      collapse({ first: 4, last: 6 }, runApi([[{ id: 4, kind: "pi.user" }]]), context),
    ).resolves.toEqual({
      tasks: [
        {
          task: APPLY_STAGED_EDITS,
          input: { pending: [], collapse: { keepRuns: 1, minTokens: 0, first: 4 } },
        },
      ],
    });
  });

  it.each([
    ["keepRuns below one", { keepRuns: 0 }, /keepRuns must be a positive integer/],
    ["a negative minTokens", { minTokens: -1 }, /minTokens must be a non-negative integer/],
  ])("rejects a collapse option with %s", (_name, collapse, message) => {
    expect(() => createPitDurableExtension({ collapse })).toThrow(message);
  });
});

describe("collapsing finished runs' tool calls", () => {
  const ALL = { keepRuns: 1, minTokens: 0 };

  function ts(id: string, code: string, extra: Record<string, unknown> = {}) {
    return { type: "toolCall", id, name: "typescript", arguments: { code, ...extra } };
  }

  /** One finished run whose tool-calling entry has `blocks`, then the current run's input. */
  function finished(blocks: any[], results: any[]) {
    const answer = 3 + results.length;
    return {
      entries: [
        user(1, "start"),
        assistant(2, blocks),
        ...results,
        assistant(answer, [{ type: "text", text: "answer" }], "stop"),
        user(answer + 1, "next"),
      ],
      first: answer + 1,
    };
  }

  async function line(blocks: any[], results: any[]): Promise<string> {
    const { entries, first } = finished(blocks, results);
    const plan = planCollapse(await view(entries), first, ALL);
    if (!plan) throw new Error("Nothing collapsed");
    return (plan.edits[0] as any).messages[0].content.at(-1).text;
  }

  const sized = (text: string) => text.replace(/~[\d.]+K? tokens/, "~N tokens");
  const READ = 'async ({ workspace: { read, search } }) => read("a")';

  it.each([
    [
      "a labelled typescript call",
      [ts("a", `// @pit: {"label": "Read the sources"}\n${READ}`)],
      [result(3, "a", BIG)],
      '[Pit: collapsed typescript call · "Read the sources" · workspace.read, workspace.search · ok · ~N tokens · originals: session.inspectEntry("2"), session.inspectEntry("3")]',
    ],
    [
      "an unlabelled call, by its program's first line",
      [ts("a", "async ({ git: { status } }) => status([])\n// more")],
      [result(3, "a", BIG)],
      '[Pit: collapsed typescript call · "async ({ git: { status } }) => status([])" · git.status · ok · ~N tokens · originals: session.inspectEntry("2"), session.inspectEntry("3")]',
    ],
    [
      "a failed call, by its error's first line",
      [ts("a", "async ({ git: { status } }) => status([])", { label: "Check status" })],
      [result(3, "a", `fatal: not a git repository\n${BIG}`, { isError: true })],
      '[Pit: collapsed typescript call · "Check status" · git.status · failed: fatal: not a git repository · ~N tokens · originals: session.inspectEntry("2"), session.inspectEntry("3")]',
    ],
    [
      "a call of another tool, by its name",
      [call("a", "read")],
      [result(3, "a", BIG, { tool: "read" })],
      '[Pit: collapsed read call · ok · ~N tokens · originals: session.inspectEntry("2"), session.inspectEntry("3")]',
    ],
    [
      "an entry with several calls and results",
      [ts("a", READ, { label: "Read" }), call("b", "echo")],
      [result(3, "a", BIG), result(4, "b", `boom\n${BIG}`, { isError: true, tool: "echo" })],
      '[Pit: collapsed 2 tool calls · typescript "Read" · workspace.read, workspace.search · ok; echo · failed: boom · ~N tokens · originals: session.inspectEntry("2"), session.inspectEntry("3"), session.inspectEntry("4")]',
    ],
    [
      "a call left without a result",
      [{ type: "toolCall", id: "a", name: "write", arguments: { content: BIG } }],
      [],
      '[Pit: collapsed write call · no result · ~N tokens · original: session.inspectEntry("2")]',
    ],
    [
      "a failed call without error text",
      [{ type: "toolCall", id: "a", name: "bash", arguments: { command: BIG } }],
      [result(3, "a", "", { isError: true, tool: "bash" })],
      '[Pit: collapsed bash call · failed · ~N tokens · originals: session.inspectEntry("2"), session.inspectEntry("3")]',
    ],
    [
      "a call that posted a question",
      [ts("a", READ, { label: "Ask which branch" })],
      [withDetails(result(3, "a", BIG), { question: { title: "Which branch?" } })],
      '[Pit: collapsed typescript call · "Ask which branch" · workspace.read, workspace.search · asked: Which branch? · ~N tokens · originals: session.inspectEntry("2"), session.inspectEntry("3")]',
    ],
    [
      "a saveOnly call, by the function it saved",
      [ts("a", "async function check({ git: { status } }) { return status([]); }", { saveOnly: true })],
      [withDetails(result(3, "a", BIG), { value: { savedFunction: "repo.check" } })],
      '[Pit: collapsed typescript call · "async function check({ git: { status } }) { return status([]); }" · saved repo.check · ~N tokens · originals: session.inspectEntry("2"), session.inspectEntry("3")]',
    ],
  ])("writes one line for %s", async (_name, blocks, results, expected) => {
    expect(sized(await line(blocks, results))).toBe(expected);
  });

  it("bounds a line to 512 bytes: functions go first, then the description's end, never the IDs", async () => {
    const names = Array.from({ length: 30 }, (_, index) => `n${index}: { f${index} }`).join(", ");
    const label = "Labél 🙂 ".repeat(40);
    const long = await line(
      [ts("a", `async ({ ${names} }) => 1`, { label })],
      [result(3, "a", `${"error ".repeat(60)}\n${BIG}`, { isError: true })],
    );
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(512);
    expect(long).not.toContain("n0.f0");
    expect(long).toContain("· failed: error error");
    expect(sized(long)).toMatch(
      / · ~N tokens · originals: session\.inspectEntry\("2"\), session\.inspectEntry\("3"\)\]$/,
    );

    const steps = Array.from({ length: 30 }, (_, index) =>
      ts(`c${index}`, "async () => 1", { label: `Step ${index} of a long series` }),
    );
    const many = await line(
      steps,
      steps.map((_, index) => result(3 + index, `c${index}`, BIG)),
    );
    expect(new TextEncoder().encode(many).length).toBeLessThanOrEqual(512);
    expect(many).not.toContain("\uFFFD");
    expect(many).toMatch(
      /^\[Pit: collapsed 30 tool calls · typescript "Step 0 of a long series" · ok; .*… · ~/,
    );
    const ids = Array.from({ length: 31 }, (_, index) => `"${index + 2}"`).join(", ");
    expect(many).toContain(`originals: session.inspectEntry(id) for ${ids}]`);

    // IDs alone over the bound: the line keeps every one and names no call.
    const crowd = Array.from({ length: 120 }, (_, index) => ts(`d${index}`, "async () => 1"));
    const crowded = await line(
      crowd,
      crowd.map((_, index) => result(3 + index, `d${index}`, BIG)),
    );
    expect(crowded).toMatch(
      /^\[Pit: collapsed 120 tool calls · ~[\d.]+K tokens · originals: session\.inspectEntry\(id\) for "2", "3", .*, "122"\]$/,
    );
  });

  it("leaves a call its line would not shrink", async () => {
    const { entries, first } = finished([ts("a", "1")], [result(3, "a", "ok")]);
    expect(planCollapse(await view(entries), first, ALL)).toBeUndefined();
  });

  const answer = (id: number) => assistant(id, [{ type: "text", text: BIG }], "stop");
  const THINKING = { type: "thinking", thinking: "why", thinkingSignature: "sig" };
  const RUNS = [
    user(1, "one"),
    assistant(2, [ts("a", "async () => 1", { label: "A" })]),
    result(3, "a", BIG),
    answer(4),
    user(5, "two"),
    assistant(6, [ts("b", "async () => 1", { label: "B" })]),
    result(7, "b", BIG),
    answer(8),
    // A host message, then the user's, start run three.
    user(9, "host note", "app.note"),
    user(10, "three"),
    assistant(11, [THINKING, { type: "text", text: "Reading." }, ts("c", "async () => 1")]),
    result(12, "c", BIG),
    answer(13),
    user(14, "four"),
    assistant(15, [ts("d", "async () => 1", { label: "D" })]),
    result(16, "d", BIG),
    answer(17),
    user(18, "current"),
    assistant(19, [ts("e", "async () => 1")]),
    result(20, "e", BIG),
  ];

  it.each([
    ["every finished run but the newest", 1, ["2", "3", "6", "7", "11", "12", "15", "16"]],
    ["all but the newest two runs", 2, ["2", "3", "6", "7", "11", "12"]],
    ["no run when keeping as many as there are", 5, undefined],
  ])("collapses %s, never an answer or a message", async (_name, keepRuns, covers) => {
    const plan = planCollapse(await view(RUNS), 18, { keepRuns, minTokens: 0 });
    expect(plan?.provenance.covers).toEqual(covers);
  });

  it("keeps an entry's thinking and text, and collapses only after the compaction head", async () => {
    const plan = planCollapse(await view(RUNS), 18, ALL);
    if (!plan) throw new Error("Nothing collapsed");
    const carrier = (plan.edits.find((edit) => edit.target === 11) as any).messages[0];
    expect(carrier.content.slice(0, 2)).toEqual([THINKING, { type: "text", text: "Reading." }]);
    expect(carrier.content[2].text).toMatch(
      /^\[Pit: collapsed typescript call · "async \(\) => 1" · ok/,
    );
    expect(carrier.stopReason).toBe("stop");

    const head = { ...user(21, "[summary]", "pi.compaction"), head: 10 };
    const compacted = planCollapse(await view([...RUNS, head], { head }), 18, ALL);
    expect(compacted?.provenance.targets).toEqual(["11", "15"]);
    expect(planCollapse(await view(RUNS), 18, { keepRuns: 1, minTokens: 100_000 })).toBeUndefined();
  });
});

describe("durable inspection of rewritten and unusual entries", () => {
  it("shows a summary carrier's coverage, an image, a user message, and a call without a result", async () => {
    const summary = planSummarize(await view(HISTORY), { from: "8", to: "9", summary: "one call" });
    const imageResult = {
      ...result(12, "z", "x"),
      model: [
        {
          ...result(12, "z", "x").model[0],
          content: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
        },
      ],
    };
    const entries = [
      ...HISTORY.slice(0, 9),
      {
        id: 11,
        conversationId: 1,
        kind: "pit.context-edit",
        data: { operations: [summary.provenance] },
        edits: summary.edits,
      },
      imageResult,
      assistant(13, [call("open")], "toolUse"),
      HISTORY[9],
    ];
    const fake = fakeApi(entries);
    const session = createDurableSessionHandler({
      api: fake.api,
      context,
      contextWindow: undefined,
      staging: new StagedContextChanges(),
    });
    await expect(session("inspectEntry", ["8"], undefined as never)).resolves.toMatchObject({
      state: "summarized",
      covers: ["8", "9"],
    });
    const image = (await session("inspectEntry", ["12"], undefined as never)) as any;
    expect(image.original.text).toBe("[image omitted]");
    await expect(session("inspectEntry", ["1"], undefined as never)).resolves.toMatchObject({
      role: "user",
    });
    const current = await view(entries);
    const note = (planElide(current, ["13"]).edits[0] as any).messages[0].content[0].text;
    expect(note).toMatch(
      /^\[Pit: elided tool call: typescript · ~\d+ tokens · originals: session\.inspectEntry\("13"\)\]$/,
    );
  });
});
