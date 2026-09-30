import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionBuilder } from "../support/context-session.js";
import {
  cleanupHarness,
  context,
  run,
  runWithParams,
  setupHarness,
  value,
} from "../support/extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

const outline = (session: SessionBuilder, options: unknown = {}) =>
  value(
    `async ({ session: { outline } }) => outline(${JSON.stringify(options)})`,
    context({ sessionManager: session.manager }),
  );

const inspect = (session: SessionBuilder, id: string, options: unknown = {}) =>
  value(
    `async ({ session: { inspectEntry } }) => inspectEntry(${JSON.stringify(id)}, ${JSON.stringify(options)})`,
    context({ sessionManager: session.manager }),
  );

function longTask() {
  const session = new SessionBuilder();
  const prompt = session.user("Fix the failing build");
  const logs = session.turn("bash", "error: missing module\n".repeat(40), { command: "npm test" });
  const source = session.turn("read", "export const value = 1;\n".repeat(20), { path: "a.ts" });
  const current = session.current();
  return { session, prompt, logs, source, current };
}

describe("session.outline", () => {
  it("lists model-visible entries with costs and protection", async () => {
    const { session, prompt, logs, source, current } = longTask();
    const result = await outline(session);

    expect(
      result.entries.map((entry: any) => ({
        id: entry.id,
        role: entry.role,
        tool: entry.tool,
        editable: entry.editable,
        protectedReason: entry.protectedReason,
        state: entry.state,
      })),
    ).toEqual([
      {
        id: prompt,
        role: "user",
        tool: undefined,
        editable: false,
        protectedReason: "user message",
        state: "original",
      },
      {
        id: logs.assistant,
        role: "assistant",
        tool: "bash",
        editable: true,
        protectedReason: undefined,
        state: "original",
      },
      {
        id: logs.result,
        role: "toolResult",
        tool: "bash",
        editable: true,
        protectedReason: undefined,
        state: "original",
      },
      {
        id: source.assistant,
        role: "assistant",
        tool: "read",
        editable: true,
        protectedReason: undefined,
        state: "original",
      },
      {
        id: source.result,
        role: "toolResult",
        tool: "read",
        editable: true,
        protectedReason: undefined,
        state: "original",
      },
      {
        id: current,
        role: "assistant",
        tool: "typescript",
        editable: false,
        protectedReason: "current turn",
        state: "original",
      },
    ]);
    // Changing an entry re-prefills it and everything after it.
    const entries = result.entries as Array<{ tokens: number; reprefillTokens: number }>;
    entries.forEach((entry, index) => {
      expect(entry.reprefillTokens).toBe(entry.tokens + (entries[index + 1]?.reprefillTokens ?? 0));
    });
    expect(entries[0]?.reprefillTokens).toBe(result.estimatedTokens);
    expect(result).toMatchObject({
      leafId: current,
      contextTokens: 1234,
      contextWindow: 200_000,
      omitted: 0,
    });
    expect(result.nextAfter).toBeUndefined();
  });

  it("pages with a cursor and counts the entries it omitted", async () => {
    const { session, prompt, logs, source, current } = longTask();

    const first = await outline(session, { limit: 2 });
    expect(first.entries.map((entry: any) => entry.id)).toEqual([prompt, logs.assistant]);
    expect(first).toMatchObject({ nextAfter: logs.assistant, omitted: 4 });

    const rest = await outline(session, { after: first.nextAfter, limit: 10 });
    expect(rest.entries.map((entry: any) => entry.id)).toEqual([
      logs.result,
      source.assistant,
      source.result,
      current,
    ]);
    expect(rest.omitted).toBe(0);
    expect(rest.nextAfter).toBeUndefined();
  });

  it("filters by role and tool while keeping each entry's own re-prefill cost", async () => {
    const { session, logs, source } = longTask();
    const all = await outline(session);
    const results = await outline(session, { roles: ["toolResult"] });
    const reads = await outline(session, { roles: ["toolResult"], tool: "read" });

    expect(results.entries.map((entry: any) => entry.id)).toEqual([logs.result, source.result]);
    expect(reads.entries.map((entry: any) => entry.id)).toEqual([source.result]);
    const full = all.entries.find((entry: any) => entry.id === source.result);
    expect(reads.entries[0].reprefillTokens).toBe(full.reprefillTokens);
  });

  it("bounds previews and strips terminal controls", async () => {
    const session = new SessionBuilder();
    const call = session.turn(
      "bash",
      "\u001b[31mred\u001b[0m\n\n   spaced   out " + "x".repeat(500),
    );
    session.current();

    const short = await outline(session, { roles: ["toolResult"], previewChars: 20 });
    const none = await outline(session, { roles: ["toolResult"], previewChars: 0 });
    const assistant = await outline(session, { roles: ["assistant"], limit: 1 });

    expect(short.entries[0]).toMatchObject({ id: call.result, preview: "red spaced out xxxx…" });
    expect(none.entries[0].preview).toBe("");
    expect(assistant.entries[0].preview).toBe("→ bash {}");
  });

  it("classifies edits by Pit's markers and by other extensions", async () => {
    const session = new SessionBuilder();
    session.user("Investigate");
    const elided = session.turn("bash", "one");
    const replaced = session.turn("bash", "two");
    const restored = session.turn("bash", "three");
    const omitted = session.turn("bash", "four");
    session.current();
    session.manager.appendContextEdit(elided.result, {
      content: '[Elided by the model · ~1 tokens · original: session.inspectEntry("x")]',
    });
    session.manager.appendContextEdit(replaced.result, { content: "trimmed by recovery" });
    session.manager.appendContextEdit(restored.result, {
      content: [{ type: "text", text: "three" }],
    });
    session.manager.appendContextEdit(omitted.result, null);

    const result = await outline(session, { roles: ["toolResult"] });
    expect(result.entries.map((entry: any) => [entry.id, entry.state])).toEqual([
      [elided.result, "elided"],
      [replaced.result, "replaced"],
      [restored.result, "original"],
    ]);
  });

  it.each<{ name: string; options: unknown; message: string }>([
    { name: "an unknown role", options: { roles: ["system"] }, message: 'unknown role "system"' },
    { name: "an oversized page", options: { limit: 201 }, message: "between 1 and 200" },
    { name: "a negative preview", options: { previewChars: -1 }, message: "between 0 and 2000" },
    {
      name: "a cursor outside the context",
      options: { after: "missing" },
      message: "Cursor missing",
    },
  ])("rejects $name", async ({ options, message }) => {
    const { session } = longTask();
    // Untyped params reach the host guard that type checking otherwise enforces.
    await expect(
      runWithParams(
        "async ({ session: { outline } }, options: any) => outline(options)",
        options,
        context({ sessionManager: session.manager }),
      ),
    ).rejects.toThrow(message);
  });
});

describe("session.inspectEntry", () => {
  it("returns the original content behind an edit", async () => {
    const session = new SessionBuilder();
    session.user("Investigate");
    const logs = session.turn("bash", "full log output", { command: "make" });
    const hidden = session.turn("bash", "hidden output");
    session.current();
    session.manager.appendContextEdit(logs.result, { content: "[Elided by the model · stub]" });
    session.manager.appendContextEdit(hidden.result, null);

    await expect(inspect(session, logs.result)).resolves.toEqual({
      id: logs.result,
      role: "toolResult",
      tool: "bash",
      state: "elided",
      original: { text: "full log output", offset: 0, totalChars: 15, truncated: false },
      visible: { text: "[Elided by the model · stub]", totalChars: 28, truncated: false },
    });
    await expect(inspect(session, hidden.result)).resolves.toMatchObject({
      state: "omitted",
      original: { text: "hidden output" },
    });
    await expect(inspect(session, logs.assistant)).resolves.toMatchObject({
      role: "assistant",
      tool: "bash",
      state: "original",
      original: { text: '→ bash {"command":"make"}' },
    });
  });

  it("pages compacted entries without splitting characters", async () => {
    const session = new SessionBuilder();
    session.user("Investigate");
    const old = session.turn("bash", "ab😀cd");
    const kept = session.user("Continue");
    session.manager.appendCompaction("summary", kept, 1000);
    session.current();

    await expect(inspect(session, old.result, { offset: 0, limit: 3 })).resolves.toMatchObject({
      role: "toolResult",
      state: "compacted",
      original: { text: "ab", offset: 0, totalChars: 6, truncated: true },
    });
    // A page starting inside a surrogate pair starts at the pair and reports its real offset.
    await expect(inspect(session, old.result, { offset: 3, limit: 10 })).resolves.toMatchObject({
      original: { text: "😀cd", offset: 2, totalChars: 6, truncated: false },
    });
    // A one-unit page never comes back empty.
    await expect(inspect(session, old.result, { offset: 2, limit: 1 })).resolves.toMatchObject({
      original: { text: "😀", offset: 2, truncated: true },
    });
  });

  it("omits thinking and images from the original text", async () => {
    const session = new SessionBuilder();
    const { id, callIds } = session.assistant(
      "Checking",
      [{ name: "read" }],
      [{ type: "thinking", thinking: "private reasoning", thinkingSignature: "sig" }],
    );
    const result = session.result(callIds[0] as string, "read", [
      { type: "text", text: "caption" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]);

    await expect(inspect(session, id)).resolves.toMatchObject({
      original: { text: "Checking\n→ read {}" },
    });
    await expect(inspect(session, result)).resolves.toMatchObject({
      original: { text: "caption\n[image omitted]" },
    });
  });

  it.each<{ name: string; target: (session: SessionBuilder) => string; message: string }>([
    {
      name: "an entry on an abandoned branch",
      target: (session) => {
        const start = session.user("Start");
        const abandoned = session.turn("bash", "old path").result;
        session.manager.branch(start);
        session.user("Retry");
        return abandoned;
      },
      message: "is not on the active branch",
    },
    {
      name: "a state entry",
      target: (session) => {
        session.user("Start");
        return session.manager.appendModelChange("test", "other");
      },
      message: "(model_change) contributes no model content",
    },
  ])("rejects $name", async ({ target, message }) => {
    const session = new SessionBuilder();
    const id = target(session);
    await expect(
      run(
        `async ({ session: { inspectEntry } }) => inspectEntry(${JSON.stringify(id)})`,
        context({ sessionManager: session.manager }),
      ),
    ).rejects.toThrow(message);
  });
});

describe("context classification", () => {
  function mixedSession() {
    const session = new SessionBuilder();
    const prompt = session.user("Start");
    session.turn("bash", "abandoned path");
    const branchSummary = session.manager.branchWithSummary(prompt, "Explored approach A");
    const bash = session.manager.appendMessage({
      role: "bashExecution",
      command: "ls",
      output: "a.ts\nb.ts",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: Date.now(),
    } as never);
    const extension = session.manager.appendCustomMessageEntry(
      "other-extension",
      "status: ok",
      true,
    );
    const system = session.manager.appendMessage({
      role: "system",
      content: "",
      sections: { preamble: "You are helpful." },
      timestamp: Date.now(),
    } as never);
    const work = session.turn("read", "file contents\n".repeat(20));
    session.current();
    return { session, prompt, branchSummary, bash, extension, system, work };
  }

  it("protects what the user, Pi, and other extensions contributed", async () => {
    const { session, prompt, branchSummary, bash, extension, work } = mixedSession();
    const result = await outline(session, { limit: 6 });

    expect(
      result.entries.map((entry: any) => [entry.id, entry.role, entry.protectedReason ?? null]),
    ).toEqual([
      [prompt, "user", "user message"],
      [branchSummary, "summary", "compaction or branch summary"],
      [bash, "bash", "user shell command"],
      [extension, "custom", "extension message"],
      [work.assistant, "assistant", null],
      [work.result, "toolResult", null],
    ]);
    expect(result.entries[2].preview).toBe("$ ls a.ts b.ts");
  });

  it("reads summaries and extension messages but not prompt state", async () => {
    const { session, branchSummary, extension, system } = mixedSession();
    const kept = session.user("Continue");
    const legacy = session.manager.appendMessage({
      role: "custom",
      customType: "legacy",
      content: "legacy status",
      display: true,
      timestamp: Date.now(),
    } as never);
    const compaction = session.manager.appendCompaction("Compacted history", kept, 1_000);
    session.current();

    const listed = (await outline(session)).entries;
    expect(listed.find((entry: any) => entry.id === compaction)).toMatchObject({
      role: "summary",
      preview: expect.stringContaining("Compacted history"),
    });
    expect(listed.find((entry: any) => entry.id === legacy)).toMatchObject({
      role: "custom",
      protectedReason: "extension message",
    });

    await expect(inspect(session, branchSummary)).resolves.toMatchObject({
      role: "summary",
      state: "compacted",
      original: { text: "Explored approach A" },
    });
    await expect(inspect(session, compaction)).resolves.toMatchObject({
      role: "summary",
      state: "original",
      original: { text: "Compacted history" },
    });
    await expect(inspect(session, extension)).resolves.toMatchObject({
      role: "custom",
      original: { text: "status: ok" },
    });
    await expect(
      run(
        `async ({ session: { inspectEntry } }) => inspectEntry(${JSON.stringify(system)})`,
        context({ sessionManager: session.manager }),
      ),
    ).rejects.toThrow(`Entry ${system} (message) contributes no model content`);
  });

  it("classifies string, image, and malformed-record edits from other extensions", async () => {
    const session = new SessionBuilder();
    const prompt = session.user("Investigate");
    const image = session.turn("bash", "output");
    session.manager.appendContextEdit(prompt, { content: "Investigate (reworded)" });
    session.manager.appendContextEdit(image.result, {
      content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
    });
    session.manager.appendCustomEntry("pit.context-edit", { operations: "not a list" });
    session.manager.appendCustomEntry("pit.context-edit", {
      operations: [null, { operation: "summarize", carrier: prompt, covers: "not a list" }],
    });
    session.current();

    const result = await outline(session, { roles: ["user", "toolResult"] });
    expect(result.entries.map((entry: any) => [entry.id, entry.state])).toEqual([
      [prompt, "replaced"],
      [image.result, "replaced"],
    ]);
  });

  it.each<{ name: string; ctx: Record<string, unknown>; expected: unknown }>([
    {
      name: "the model's window when usage is unknown",
      ctx: {
        getContextUsage: () => undefined,
        model: { provider: "p", id: "m", contextWindow: 128_000 },
      },
      expected: { contextTokens: null, contextWindow: 128_000 },
    },
    {
      name: "nulls without usage or a model",
      ctx: { getContextUsage: () => undefined, model: undefined },
      expected: { contextTokens: null, contextWindow: null },
    },
  ])("reports $name", async ({ ctx, expected }) => {
    const { session } = longTask();
    const result = await value(
      "async ({ session: { outline } }) => outline()",
      context({ sessionManager: session.manager, ...ctx }),
    );
    expect(result).toMatchObject(expected as object);
  });
});
