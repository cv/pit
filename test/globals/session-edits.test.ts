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
  const current = session.current();
  return { session, prompt, logs, source, current };
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
    const { session, prompt, logs, current } = longTask();
    const ids = [prompt, current, logs.assistant, "missing"];

    await expect(
      run(
        `async ({ session: { elide } }) => elide(${JSON.stringify(ids)})`,
        context({ sessionManager: session.manager }),
      ),
    ).rejects.toThrow(
      `Cannot elide: ${prompt} is protected: user message; ${current} is protected: current turn; ${logs.assistant} is an assistant entry; elide accepts tool results, and session.summarize replaces assistant turns; missing is not on the active branch`,
    );
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

describe("session.restore", () => {
  it("returns an elided result to its original content", async () => {
    const { session, logs } = longTask();
    await call(
      session,
      `async ({ session: { elide } }) => elide([${JSON.stringify(logs.result)}])`,
    );
    await endTurn(session);
    session.current();

    const receipt = await call(
      session,
      `async ({ session: { restore } }) => restore([${JSON.stringify(logs.result)}])`,
    );
    expect(receipt).toMatchObject({
      status: "staged",
      operation: "restore",
      targets: [logs.result],
      restoredChars: LOG.length,
    });
    expect(receipt.estimatedTokensFreed).toBeLessThan(-300);

    const entries = await endTurn(session);
    expect(modelText(session, logs.result)).toBe(LOG);
    expect((entries.at(-1) as any).data.operations).toEqual([
      expect.objectContaining({ operation: "restore", targets: [logs.result] }),
    ]);
    session.current();
    const outline = await call(
      session,
      "async ({ session: { outline } }) => outline({ roles: ['toolResult'], limit: 1 })",
    );
    expect(outline.entries[0]).toMatchObject({ id: logs.result, state: "original" });
  });

  it("refuses entries that Pit did not edit", async () => {
    const session = new SessionBuilder();
    session.user("Investigate");
    const untouched = session.turn("bash", LOG);
    const replaced = session.turn("bash", LOG);
    const omitted = session.turn("bash", LOG);
    session.manager.appendContextEdit(replaced.result, { content: "trimmed by another extension" });
    session.manager.appendContextEdit(omitted.result, null);
    session.current();
    const ids = [untouched.result, replaced.result, omitted.result];

    await expect(
      run(
        `async ({ session: { restore } }) => restore(${JSON.stringify(ids)})`,
        context({ sessionManager: session.manager }),
      ),
    ).rejects.toThrow(
      `Cannot restore: ${untouched.result} is not edited; ${replaced.result} was edited outside Pit; ${omitted.result} was omitted outside Pit`,
    );
  });

  it("refuses compacted entries", async () => {
    const session = new SessionBuilder();
    session.user("Investigate");
    const old = session.turn("bash", LOG);
    const kept = session.user("Continue");
    session.manager.appendCompaction("summary", kept, 1000);
    session.current();

    await expect(
      run(
        `async ({ session: { restore } }) => restore([${JSON.stringify(old.result)}])`,
        context({ sessionManager: session.manager }),
      ),
    ).rejects.toThrow(`${old.result} was compacted`);
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
