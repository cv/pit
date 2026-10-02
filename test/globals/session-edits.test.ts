import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { contextBoundaryEntries } from "../../src/context/boundary.js";
import { ContextEditQueue } from "../../src/context/queue.js";
import { createSessionHostHandler } from "../../src/host/handlers/session.js";
import { endTurn, SessionBuilder } from "../support/context-session.js";
import {
  cleanupHarness,
  context,
  emit,
  run,
  runWithParams,
  setupHarness,
  value,
} from "../support/extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

const LOG = "error: missing module ./generated\n".repeat(40);

function longTask() {
  const session = new SessionBuilder();
  const prompt = session.user("Fix the failing build");
  const logs = session.turn("bash", LOG, { command: "npm test" });
  const source = session.turn("read", "export const value = 1;\n".repeat(30), { path: "a.ts" });
  // An assistant reply with no tool calls, before the running turn.
  const reply = session.assistant("Done.").id;
  const current = session.current();
  return { session, prompt, logs, source, reply, current };
}

const call = (session: SessionBuilder, code: string) =>
  value(code, context({ sessionManager: session.manager }));

const modelText = (session: SessionBuilder, id: string) => {
  const projected = session.manager
    .buildSessionProjection()
    .entries.find((entry) => entry.sourceEntry.id === id);
  return (projected?.messages[0] as any)?.content?.[0]?.text;
};

describe("session.elide", () => {
  it("stages stubs until the turn ends, then shows them to the model", async () => {
    const { session, logs } = longTask();

    const receipt = await call(
      session,
      `async ({ session: { elide } }) => elide([${JSON.stringify(logs.result)}], { reason: "stale build log" })`,
    );
    expect(receipt).toMatchObject({
      status: "staged",
      appliesAt: "turn_end",
      operation: "elide",
      targets: [logs.result],
    });
    expect(receipt.estimatedTokensFreed).toBeGreaterThan(300);
    expect(receipt.estimatedReprefillTokens).toBeGreaterThan(0);

    // Staged, not applied: the model still sees the log, and the outline says it is pending.
    expect(modelText(session, logs.result)).toBe(LOG);
    const pending = await call(
      session,
      "async ({ session: { outline } }) => outline({ roles: ['toolResult'], limit: 1 })",
    );
    expect(pending.entries[0]).toMatchObject({
      id: logs.result,
      state: "original",
      pending: "elide",
    });

    const entries = await endTurn(session);
    expect(entries.map((entry) => entry.type)).toEqual(["context_edit", "custom"]);
    expect(modelText(session, logs.result)).toBe(
      `[Elided by the model · ~${Math.ceil(LOG.length / 4)} tokens · reason: stale build log · original: session.inspectEntry("${logs.result}")]`,
    );
    expect(entries[1]).toMatchObject({
      customType: "pit.context-edit",
      data: {
        version: 1,
        operations: [
          {
            toolCallId: "call-id",
            operation: "elide",
            targets: [logs.result],
            reason: "stale build log",
            tokensFreed: receipt.estimatedTokensFreed,
          },
        ],
      },
    });

    // Raw history keeps the original, and inspectEntry still returns it.
    const raw = session.manager.getEntry(logs.result) as any;
    expect(raw.message.content[0].text).toBe(LOG);
    session.current();
    const inspected = await call(
      session,
      `async ({ session: { inspectEntry } }) => inspectEntry(${JSON.stringify(logs.result)})`,
    );
    expect(inspected).toMatchObject({ state: "elided", original: { text: LOG } });
  });

  it.each<{ name: string; options: { isError?: boolean; outcome?: "aborted" } }>([
    { name: "the staging call fails", options: { isError: true } },
    { name: "the turn is aborted", options: { outcome: "aborted" } },
  ])("discards staged edits when $name", async ({ options }) => {
    const { session, logs } = longTask();
    await call(
      session,
      `async ({ session: { elide } }) => elide([${JSON.stringify(logs.result)}])`,
    );
    const notify = vi.fn();

    const entries = await endTurn(session, { ...options, ctx: { ui: { notify } } });

    expect(entries).toEqual([]);
    expect(modelText(session, logs.result)).toBe(LOG);
    expect(notify).toHaveBeenCalledWith(
      "Pit discarded staged context edits: 1 edit whose tool call did not succeed.",
      "warning",
    );
  });

  it("keeps the entries earlier boundary handlers proposed", async () => {
    const { session, logs } = longTask();
    await call(
      session,
      `async ({ session: { elide } }) => elide([${JSON.stringify(logs.result)}])`,
    );
    const earlier = {
      type: "custom" as const,
      customType: "other-extension",
      data: { kept: true },
    };

    const entries = await endTurn(session, { entries: [earlier] });

    expect(entries.map((entry) => entry.type)).toEqual(["custom", "context_edit", "custom"]);
    expect(entries[0]).toBe(earlier);
  });

  it.each(["session_tree", "session_start"])("drops staged edits on %s", async (event) => {
    const { session, logs } = longTask();
    await call(
      session,
      `async ({ session: { elide } }) => elide([${JSON.stringify(logs.result)}])`,
    );

    await emit(event, { type: event }, context({ sessionManager: session.manager }));

    expect(await endTurn(session)).toEqual([]);
    expect(modelText(session, logs.result)).toBe(LOG);
  });

  it("explains every rejected target in one error", async () => {
    const { session, prompt, logs, reply, current } = longTask();
    const ids = [prompt, current, reply, logs.assistant, "missing"];

    await expect(
      run(
        `async ({ session: { elide } }) => elide(${JSON.stringify(ids)})`,
        context({ sessionManager: session.manager }),
      ),
    ).rejects.toThrow(
      `Cannot elide: ${prompt} is protected: user message; ${current} is protected: current turn; ${reply} is an assistant entry without tool calls; elide shrinks tool results and tool-call arguments, and session.summarize replaces assistant turns; ${logs.assistant} is no larger than its elision stub; missing is not on the active branch`,
    );
  });

  it("names the targets that can be elided when others are rejected", async () => {
    const { session, logs, source, reply } = longTask();

    await expect(
      runWithParams(
        "async ({ session: { elide } }, ids: string[]) => elide(ids)",
        [reply, logs.result, source.result],
        context({ sessionManager: session.manager }),
      ),
    ).rejects.toThrow(
      new RegExp(
        `^Cannot elide: ${reply} is an assistant entry without tool calls; .*\\. These can be elided: \\["${logs.result}","${source.result}"\\]$`,
      ),
    );
  });

  // #222: in long coding sessions tool-call arguments were 93% of the assistant side of context,
  // and elide could not touch them.
  it("stubs an assistant entry's tool-call arguments and keeps everything else", async () => {
    const session = new SessionBuilder();
    session.user("Rewrite the parser");
    const program =
      'async ({ workspace: { edit } }) => edit("src/parse.ts", { revision: "r1", changes: [] });\n'.repeat(
        40,
      );
    const signed = {
      type: "thinking" as const,
      thinking: "Plan the rewrite.",
      thinkingSignature: "sig-abc",
    };
    const { id, callIds } = session.assistant(
      "Writing the new parser.",
      [{ name: "typescript", args: { code: program } }],
      [signed],
    );
    const result = session.result(callIds[0] as string, "typescript", '{"applied":1}');
    session.current();

    const receipt = await call(
      session,
      `async ({ session: { elide } }) => elide([${JSON.stringify(id)}], { reason: "parser written" })`,
    );
    expect(receipt).toMatchObject({ operation: "elide", targets: [id], toolCallEntries: 1 });
    expect(receipt.estimatedTokensFreed).toBeGreaterThan(500);
    await endTurn(session);

    const projected = session.manager
      .buildSessionProjection()
      .entries.find((entry) => entry.sourceEntry.id === id);
    const message = projected?.messages[0] as unknown as {
      content: Array<Record<string, unknown>>;
    };
    const { content } = message;
    // Thinking (with its signature), text, and the call's ID and name stay for replay.
    expect(content.slice(0, 2)).toEqual([
      signed,
      { type: "text", text: "Writing the new parser." },
    ]);
    expect(content[2]).toMatchObject({ type: "toolCall", id: callIds[0], name: "typescript" });
    expect((content[2] as { arguments: { elided: string } }).arguments).toEqual({
      elided: expect.stringMatching(
        new RegExp(
          `^\\[Pit: these arguments were elided to save context; this is not the original call · ~[\\d.]+K? tokens · reason: parser written · original: session\\.inspectEntry\\("${id}"\\)\\]$`,
        ),
      ),
    });
    // The result still answers the call.
    expect(modelText(session, result)).toBe('{"applied":1}');

    const view = await call(
      session,
      `async ({ session: { outline, inspectEntry } }) => ({ outline: await outline({ roles: ["assistant"], limit: 5 }), original: await inspectEntry(${JSON.stringify(id)}) })`,
    );
    expect(view.outline.entries.find((entry: { id: string }) => entry.id === id)).toMatchObject({
      state: "elided",
    });
    expect(view.original.original.text).toContain("src/parse.ts");
  });

  it("elides tool results and tool calls in one batch and names both in the receipt", async () => {
    const session = new SessionBuilder();
    session.user("Fix the failing build");
    const logs = session.turn("bash", LOG, { command: "npm test" });
    const big = session.turn("typescript", "1", { code: "async () => 1;\n".repeat(200) });
    session.current();

    const receipt = await call(
      session,
      `async ({ session: { elide } }) => elide(${JSON.stringify([logs.result, big.assistant])})`,
    );
    expect(receipt).toMatchObject({ targets: [logs.result, big.assistant], toolCallEntries: 1 });
  });

  it("rejects a second edit of the same target, staged or applied", async () => {
    const { session, logs } = longTask();
    const elide = `async ({ session: { elide } }) => elide([${JSON.stringify(logs.result)}])`;
    await call(session, elide);

    await expect(run(elide, context({ sessionManager: session.manager }))).rejects.toThrow(
      `${logs.result} already has a staged elide in this turn`,
    );

    await endTurn(session);
    session.current();
    await expect(run(elide, context({ sessionManager: session.manager }))).rejects.toThrow(
      `${logs.result} is already elided`,
    );
  });

  it("rejects a result that is no larger than its stub", async () => {
    const session = new SessionBuilder();
    const tiny = session.turn("bash", "ok");
    session.current();

    await expect(
      run(
        `async ({ session: { elide } }) => elide([${JSON.stringify(tiny.result)}])`,
        context({ sessionManager: session.manager }),
      ),
    ).rejects.toThrow(`${tiny.result} is no larger than its elision stub`);
  });

  it("writes the reason as one sanitized line", async () => {
    const { session, logs } = longTask();
    await runWithParams(
      "async ({ session: { elide } }, input: { id: string; reason: string }) => elide([input.id], { reason: input.reason })",
      { id: logs.result, reason: "  stale\n\u001b[31mbuild\u001b[0m\tlog  " },
      context({ sessionManager: session.manager }),
    );
    await endTurn(session);

    expect(modelText(session, logs.result)).toContain(" · reason: stale build log · ");
  });

  it.each<{ name: string; ids: unknown; options?: unknown; message: string }>([
    { name: "no IDs", ids: [], message: "ids must list 1-200 entry IDs; received 0" },
    {
      name: "too many IDs",
      ids: Array.from({ length: 201 }, (_, index) => `id-${index}`),
      message: "received 201",
    },
    { name: "a repeated ID", ids: ["a", "a"], message: "ids lists a more than once" },
    {
      name: "an overlong reason",
      ids: ["a"],
      options: { reason: "x".repeat(201) },
      message: "options.reason must be at most 200 characters",
    },
  ])("rejects $name", async ({ ids, options, message }) => {
    const { session } = longTask();
    await expect(
      runWithParams(
        "async ({ session: { elide } }, input: any) => elide(input.ids, input.options)",
        { ids, options: options ?? {} },
        context({ sessionManager: session.manager }),
      ),
    ).rejects.toThrow(message);
  });

  it("requires a running Pit tool call", () => {
    const { session, logs } = longTask();
    const handler = createSessionHostHandler({
      pi: {} as never,
      ctx: context({ sessionManager: session.manager }) as never,
    });
    expect(() => handler("elide", [[logs.result]])).toThrow(
      "Context edits require a running Pit tool call",
    );
  });
});

describe("context edit boundary", () => {
  it("discards an edit whose target left the active branch", () => {
    const session = new SessionBuilder();
    session.user("Investigate");
    const queue = new ContextEditQueue();
    queue.stage({
      toolCallId: "call-id",
      operation: "elide",
      targets: ["gone"],
      drafts: [{ type: "context_edit", targetId: "gone", replacement: null }],
      records: [],
    });
    const notify = vi.fn();

    const entries = contextBoundaryEntries(
      {
        outcome: "completed",
        toolResults: [{ toolCallId: "call-id", isError: false } as any],
      },
      context({ sessionManager: session.manager, ui: { notify } }) as any,
      queue,
    );

    expect(entries).toEqual([]);
    expect(notify).toHaveBeenCalledWith(
      "Pit discarded staged context edits: 1 edit whose targets left the active branch.",
      "warning",
    );
  });
});

describe("context edit edge cases", () => {
  function manyResults(count: number) {
    const session = new SessionBuilder();
    session.user("Investigate");
    const results = Array.from({ length: count }, () => session.turn("bash", LOG).result);
    session.current();
    return { session, results };
  }

  it("lists the first five problems and counts the rest", async () => {
    const { session, results } = manyResults(1);
    session.manager.appendContextEdit(results[0] as string, null);
    session.current();
    const ids = [results[0] as string, "m1", "m2", "m3", "m4", "m5", "m6"];

    await expect(
      runWithParams(
        "async ({ session: { elide } }, ids: string[]) => elide(ids)",
        ids,
        context({ sessionManager: session.manager }),
      ),
    ).rejects.toThrow(
      `Cannot elide: ${results[0]} is not model-visible; m1 is not on the active branch; m2 is not on the active branch; m3 is not on the active branch; m4 is not on the active branch; and 2 more`,
    );
  });

  it("names at most five conflicting targets", async () => {
    const { session, results } = manyResults(6);
    const elide = () =>
      runWithParams(
        "async ({ session: { elide } }, ids: string[]) => elide(ids)",
        results,
        context({ sessionManager: session.manager }),
      );
    await elide();

    await expect(elide()).rejects.toThrow(
      `${results.slice(0, 5).join(", ")} and 1 more already have a staged elide in this turn`,
    );
  });

  it("counts every discarded edit and stays quiet without a UI", async () => {
    const { session, results } = manyResults(2);
    for (const id of results) {
      await runWithParams(
        "async ({ session: { elide } }, id: string) => elide([id])",
        id,
        context({ sessionManager: session.manager }),
      );
    }
    const notify = vi.fn();
    await endTurn(session, { isError: true, ctx: { ui: { notify } } });
    expect(notify).toHaveBeenCalledWith(
      "Pit discarded staged context edits: 2 edits whose tool call did not succeed.",
      "warning",
    );

    session.current();
    await runWithParams(
      "async ({ session: { elide } }, id: string) => elide([id])",
      results[0],
      context({ sessionManager: session.manager }),
    );
    const quiet = vi.fn();
    await endTurn(session, { isError: true, ctx: { hasUI: false, ui: { notify: quiet } } });
    expect(quiet).not.toHaveBeenCalled();
  });

  it("omits a reason that is blank after sanitizing", async () => {
    const { session, results } = manyResults(1);
    await runWithParams(
      "async ({ session: { elide } }, id: string) => elide([id], { reason: ' \\n\\t ' })",
      results[0],
      context({ sessionManager: session.manager }),
    );
    await endTurn(session);

    expect(modelText(session, results[0] as string)).not.toContain("reason:");
  });

  it("refuses to elide a Pit notice", async () => {
    const { session } = manyResults(1);
    const notice = session.manager.appendCustomMessageEntry(
      "pit.context-pressure",
      "x".repeat(4_000),
      true,
      {
        level: 50,
      },
    );
    session.current();

    await expect(
      run(
        `async ({ session: { elide } }) => elide([${JSON.stringify(notice)}])`,
        context({ sessionManager: session.manager }),
      ),
    ).rejects.toThrow(`${notice} is a notice entry; elide accepts tool results`);
  });

  it("answers read-only queries outside a Pit tool call", async () => {
    const { session } = manyResults(1);
    const handler = createSessionHostHandler({
      pi: {} as never,
      ctx: context({ sessionManager: session.manager }) as never,
    });

    expect(handler("outline", [])).toMatchObject({ entries: expect.any(Array), omitted: 0 });
    expect(handler("notes", [])).toMatchObject({ notes: [], budgetTokens: 20_000 });
  });
});
