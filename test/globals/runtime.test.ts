import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CompletedCallJournal, RecoverableCallStore } from "../../src/execution/completed-calls.js";
import { createRuntimeHostHandler } from "../../src/host/handlers/runtime.js";
import { recoverableNotice } from "../../src/tool/failure-context.js";
import {
  cleanupHarness,
  context,
  emit,
  getRegisteredCommand,
  setupHarness,
  tool,
  toolResult,
  value,
} from "../support/extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

describe("runtime namespace", () => {
  it("reports runtime status", async () => {
    await expect(
      value("async ({ runtime: { status: runtimeStatus } }) => runtimeStatus()"),
    ).resolves.toEqual({
      mode: "interactive",
      idle: true,
      pendingMessages: false,
    });

    const handler = createRuntimeHostHandler({
      pi: {} as never,
      ctx: context() as never,
    });
    expect(await handler("unknown", [])).toBeUndefined();
  });

  it.each([
    "pit-reload-runtime",
    "pit-shutdown",
    "pit-new-session",
    "pit-fork-session",
    "pit-clone-session",
  ])("does not register unsupported command %s", (name) => {
    expect(getRegisteredCommand(name)).toBeUndefined();
  });
});

/** A feed tool that hands out each chunk once, like #205's feed_next. */
function feedContext() {
  let chunk = 0;
  const executeTool = vi.fn(async (name: string, args: unknown) => ({
    toolCall: { type: "toolCall", id: `call/${name}`, name, arguments: args },
    result: { content: [{ type: "text", text: `chunk ${++chunk}: TX-${chunk}0 deposit 5` }] },
    isError: false,
  }));
  const tools = [
    {
      name: "feed_next",
      description: "Returns the next chunk; chunks cannot be replayed.",
      parameters: { type: "object", properties: {} },
    },
  ];
  return { ctx: context({ tools, executeTool }), executeTool };
}

const failing = `async ({ tools: { feed_next }, workspace: { stat } }) => {
  const text = await feed_next();
  await stat("missing-state-file.json");
  return text;
}`;

describe("recovering a failed program's completed calls", () => {
  // In #205, a program consumed feed chunk 19 and then failed, and the chunk was lost.
  it("returns a consumed tool result after the program fails, without repeating the call", async () => {
    const { ctx, executeTool } = feedContext();
    await expect(
      tool.execute("failed-run", { code: failing }, undefined, undefined, ctx),
    ).rejects.toThrow();

    const enriched = await toolResult({
      toolName: "typescript",
      toolCallId: "failed-run",
      isError: true,
    });
    expect(enriched.content[0].text).toContain(
      '[Recoverable: results of 1 call this program completed. Read them with runtime.completedCalls("failed-run") instead of repeating calls that consumed input.]',
    );
    expect(enriched.details.recoverable).toEqual({
      toolCallId: "failed-run",
      calls: 1,
      omitted: 0,
    });

    const recovered = await value(
      'async ({ runtime: { completedCalls } }) => completedCalls("failed-run")',
      ctx,
    );
    expect(recovered).toEqual({
      toolCallId: "failed-run",
      calls: [{ sequence: 1, call: "tools.feed_next", value: "chunk 1: TX-10 deposit 5" }],
      omitted: 0,
    });
    expect(executeTool).toHaveBeenCalledOnce();
  });

  it("selects one call by sequence and explains unknown IDs and sequences", async () => {
    const { ctx } = feedContext();
    const code = `async ({ tools: { feed_next } }) => { await feed_next(); await feed_next(); throw new Error("parse failed"); }`;
    await expect(tool.execute("two-chunks", { code }, undefined, undefined, ctx)).rejects.toThrow(
      "parse failed",
    );

    const result = await value(
      `async ({ runtime: { completedCalls } }) => {
      const capture = async (run) => { try { return await run(); } catch (error) { return error.message; } };
      return {
        second: await completedCalls("two-chunks", { sequence: 2 }),
        missingSequence: await capture(() => completedCalls("two-chunks", { sequence: 9 })),
        unknown: await capture(() => completedCalls("never-ran")),
      };
    }`,
      ctx,
    );
    expect(result.second.calls).toEqual([
      { sequence: 2, call: "tools.feed_next", value: "chunk 2: TX-20 deposit 5" },
    ]);
    expect(result.missingSequence).toBe("two-chunks kept no completed call with sequence 9");
    expect(result.unknown).toBe(
      "No recoverable calls for never-ran: Pit keeps them only for the 8 most recent failed programs in this Pi session.",
    );
  });

  // v0.24.0 journaled a call that cancellation interrupted: the process runner settles an aborted
  // command with exit 130, so a cancelled program claimed one recoverable call it never received.
  it("does not count a call that cancellation interrupted as completed", async () => {
    const ctx = context();
    const controller = new AbortController();
    const running = tool.execute(
      "cancelled",
      {
        code: 'async ({ shell: { execFile } }) => execFile("sleep", ["30"], { timeoutMs: 120000 })',
      },
      controller.signal,
      () => undefined,
      ctx,
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
    controller.abort();
    await expect(running).rejects.toThrow("cancelled while 1 host call was still running");

    const cancelled = await toolResult({
      toolName: "typescript",
      toolCallId: "cancelled",
      isError: true,
    });
    expect(cancelled.content[0].text).not.toContain("Recoverable");
    expect(cancelled.details).not.toHaveProperty("recoverable");
  });

  it("does not count Pit's internal saved-function calls as recoverable", async () => {
    const { ctx } = feedContext();
    await tool.execute(
      "define",
      {
        code: 'async function parseChunk({}, text: string) { throw new Error("bad chunk: " + text); }',
        saveOnly: true,
      },
      undefined,
      undefined,
      ctx,
    );
    const code = "async ({ tools: { feed_next }, parseChunk }) => parseChunk(await feed_next())";
    await expect(
      tool.execute("feed-then-saved", { code }, undefined, undefined, ctx),
    ).rejects.toThrow("bad chunk");
    const recovered = await value(
      'async ({ runtime: { completedCalls } }) => completedCalls("feed-then-saved")',
      ctx,
    );
    expect(recovered.calls.map((call: { call: string }) => call.call)).toEqual(["tools.feed_next"]);
  });

  it("keeps nothing for a successful program or a failure with no completed calls", async () => {
    const { ctx } = feedContext();
    await tool.execute(
      "succeeded",
      { code: "async ({ tools: { feed_next } }) => feed_next()" },
      undefined,
      undefined,
      ctx,
    );
    await expect(
      tool.execute(
        "nothing-done",
        { code: 'async () => { throw new Error("early"); }' },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow("early");
    const early = await toolResult({
      toolName: "typescript",
      toolCallId: "nothing-done",
      isError: true,
    });
    expect(early.content[0].text).not.toContain("Recoverable");
    expect(early.details).not.toHaveProperty("recoverable");

    const result = await value(
      `async ({ runtime: { completedCalls } }) => {
      const capture = async (id) => { try { await completedCalls(id); return "kept"; } catch { return "none"; } };
      return [await capture("succeeded"), await capture("nothing-done")];
    }`,
      ctx,
    );
    expect(result).toEqual(["none", "none"]);
  });

  it("forgets recoverable calls when a new Pi session starts", async () => {
    const { ctx } = feedContext();
    await expect(
      tool.execute("before-restart", { code: failing }, undefined, undefined, ctx),
    ).rejects.toThrow();
    await emit("session_start", { type: "session_start", reason: "startup" }, ctx);

    await expect(
      value('async ({ runtime: { completedCalls } }) => completedCalls("before-restart")', ctx),
    ).rejects.toThrow("No recoverable calls for before-restart");
  });
});

describe("completed-call journal bounds", () => {
  it("keeps the newest calls within its entry and byte budgets and counts the rest", () => {
    const journal = new CompletedCallJournal(2, 40);
    journal.record(1, "a.one", "x".repeat(10));
    journal.record(2, "a.two", "y".repeat(10));
    journal.record(3, "a.three", "z".repeat(10));
    // Too large on its own: never kept.
    journal.record(4, "a.four", "w".repeat(100));
    // Not JSON: counted, not kept.
    journal.record(5, "a.five", 10n);

    expect(journal.calls().map(({ sequence }) => sequence)).toEqual([2, 3]);
    expect(journal.omitted).toBe(3);
  });

  it("keeps only the most recent failed programs", () => {
    const store = new RecoverableCallStore(2);
    for (const id of ["first", "second", "third"]) {
      const journal = new CompletedCallJournal();
      journal.record(1, "tools.feed_next", id);
      store.retain(id, journal);
    }
    expect(() => store.read("first")).toThrow("No recoverable calls for first");
    expect(store.read("third").calls[0]?.value).toBe("third");
  });

  it.each([
    { name: "one call", calls: 1, omitted: 0, text: "results of 1 call this program completed." },
    {
      name: "several calls, some not kept",
      calls: 3,
      omitted: 2,
      text: "results of 3 calls this program completed; 2 more were not kept.",
    },
  ])("words the recoverable notice for $name", ({ calls, omitted, text }) => {
    expect(recoverableNotice({ toolCallId: "id", calls, omitted })).toContain(text);
  });

  it("snapshots values so later mutation by the program cannot change them", () => {
    const journal = new CompletedCallJournal();
    const value = { rows: [1, 2] };
    journal.record(1, "workspace.read", value);
    value.rows.push(3);
    expect(journal.calls()).toEqual([
      { sequence: 1, call: "workspace.read", value: { rows: [1, 2] } },
    ]);
  });
});
