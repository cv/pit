import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { endTurn, SessionBuilder } from "../support/context-session.js";
import {
  cleanupHarness,
  context,
  runWithParams,
  setPiSettings,
  setupHarness,
} from "../support/extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

const OUTPUT = "line of tool output\n".repeat(60);

function agentRun() {
  const session = new SessionBuilder();
  const prompt = session.user("Optimize the solver");
  const first = session.turn("bash", OUTPUT, { command: "make bench" });
  const second = session.turn("read", OUTPUT, { path: "solver.ts" });
  const third = session.turn("bash", OUTPUT, { command: "make test" });
  const current = session.current();
  return { session, prompt, first, second, third, current };
}

type Run = ReturnType<typeof agentRun>;

const summarize = (
  session: SessionBuilder,
  input: { from: string; to: string; summary: string },
  ctx: Record<string, unknown> = {},
) =>
  runWithParams(
    "async ({ session: { summarize } }, input: { from: string; to: string; summary: string }) => summarize(input)",
    input,
    context({ sessionManager: session.manager, ...ctx }),
  ).then((result) => result.details.value);

const call = (session: SessionBuilder, code: string, params: unknown) =>
  runWithParams(code, params, context({ sessionManager: session.manager })).then(
    (result) => result.details.value,
  );

/** What the provider receives: LLM-role messages with their content. */
const llm = (session: SessionBuilder) =>
  session.manager
    .buildSessionContext()
    .messages.filter((message) => message.role !== "system")
    .map((message: any) => ({ role: message.role, content: message.content }));

describe("session.summarize", () => {
  it("puts the summary in the range's first assistant entry and keeps its tool calls paired", async () => {
    const { session, first, second, third } = agentRun();

    const receipt = await summarize(session, {
      from: first.assistant,
      to: second.result,
      summary: "Benchmark: 12.4s. The parser dominates solver.ts.",
    });
    expect(receipt).toMatchObject({
      status: "staged",
      operation: "summarize",
      targets: [first.assistant, first.result, second.assistant, second.result],
      summarizedEntries: 4,
    });
    expect(receipt.estimatedTokensFreed).toBeGreaterThan(200);

    await endTurn(session);
    const messages = llm(session);
    // The carrier keeps its call and its result becomes a stub, so roles still alternate.
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
    ]);
    expect(messages[1]?.content).toEqual([
      {
        type: "text",
        text: `[Model summary of 4 entries from ${first.assistant} to ${second.result} · originals: session.inspectEntry(id)]\n\nBenchmark: 12.4s. The parser dominates solver.ts.`,
      },
      { type: "toolCall", id: first.callId, name: "bash", arguments: { command: "make bench" } },
    ]);
    expect(messages[2]?.content[0].text).toMatch(
      new RegExp(
        `^\\[Elided by the model · ~\\d+ tokens · reason: summarized · original: session\\.inspectEntry\\("${first.result}"\\)\\]$`,
      ),
    );
    expect(messages[3]?.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: third.callId })]),
    );

    session.current();
    const carrier = await call(
      session,
      "async ({ session: { inspectEntry } }, id: string) => inspectEntry(id)",
      first.assistant,
    );
    expect(carrier).toMatchObject({
      state: "summarized",
      covers: [first.assistant, first.result, second.assistant, second.result],
    });
    const member = await call(
      session,
      "async ({ session: { inspectEntry } }, id: string) => inspectEntry(id)",
      second.result,
    );
    expect(member).toMatchObject({ state: "summarized", original: { text: OUTPUT } });
  });

  it("folds an earlier summary into a larger one and lists every entry it covers", async () => {
    const { session, first, second, third } = agentRun();
    await summarize(session, { from: first.assistant, to: second.result, summary: "Inner." });
    await endTurn(session);
    session.current();

    const receipt = await summarize(session, {
      from: first.assistant,
      to: third.result,
      summary: "Outer.",
    });
    expect(receipt.targets).toEqual(
      expect.arrayContaining([second.assistant, second.result, third.assistant, third.result]),
    );
    await endTurn(session);
    session.current();

    const texts = llm(session).flatMap((message: any) =>
      Array.isArray(message.content) ? message.content.map((block: any) => block.text ?? "") : [],
    );
    expect(texts.some((text: string) => text.endsWith("\n\nOuter."))).toBe(true);
    expect(texts.some((text: string) => text.endsWith("\n\nInner."))).toBe(false);
    const carrier = await call(
      session,
      "async ({ session: { inspectEntry } }, id: string) => inspectEntry(id)",
      first.assistant,
    );
    expect(carrier.covers).toEqual(
      expect.arrayContaining([
        first.assistant,
        first.result,
        second.assistant,
        second.result,
        third.assistant,
        third.result,
      ]),
    );
    const inner = await call(
      session,
      "async ({ session: { inspectEntry } }, id: string) => inspectEntry(id)",
      second.result,
    );
    expect(inner).toMatchObject({ state: "summarized", original: { text: OUTPUT } });
  });

  it.each<{
    name: string;
    input: (run: Run) => { from: string; to: string };
    message: (run: Run) => string;
  }>([
    {
      name: "a range that starts at a tool result",
      input: ({ first, second }) => ({ from: first.result, to: second.result }),
      message: ({ first, second }) =>
        `a range starts at an assistant entry; ${first.result} is a toolResult entry; ${first.result} answers a tool call outside the range. Try summarize({ from: "${first.assistant}", to: "${second.result}" })`,
    },
    {
      name: "a range that separates a call from its result",
      input: ({ first }) => ({ from: first.assistant, to: first.assistant }),
      message: ({ first }) =>
        `${first.result} answers a tool call in the range; end the range at or after it. Try summarize({ from: "${first.assistant}", to: "${first.result}" })`,
    },
    {
      name: "a range that includes the user's message",
      input: ({ prompt, first }) => ({ from: prompt, to: first.result }),
      message: ({ prompt, first }) =>
        `${prompt} is protected: user message. Try summarize({ from: "${first.assistant}", to: "${first.result}" })`,
    },
    {
      name: "a range that reaches the running turn",
      input: ({ third, current }) => ({ from: third.assistant, to: current }),
      message: ({ current }) => `${current} is protected: current turn`,
    },
    {
      // No suggestion: there is no assistant turn to start from.
      name: "a range without an assistant turn",
      input: ({ prompt }) => ({ from: prompt, to: prompt }),
      message: ({ prompt }) => `${prompt} is protected: user message`,
    },
    {
      // No suggestion: the repaired range would still reach the running turn.
      name: "a range from a tool result into the running turn",
      input: ({ third, current }) => ({ from: third.result, to: current }),
      message: ({ current }) => `${current} is protected: current turn`,
    },
    {
      name: "a reversed range",
      input: ({ first, second }) => ({ from: second.assistant, to: first.result }),
      message: ({ first, second }) => `${second.assistant} comes after ${first.result}`,
    },
    {
      name: "unknown entries",
      input: () => ({ from: "nope", to: "gone" }),
      message: () =>
        "Cannot summarize: nope is not on the active branch; gone is not on the active branch",
    },
  ])("rejects $name", async ({ input, message }) => {
    const run = agentRun();
    const error = await summarize(run.session, { ...input(run), summary: "Summary." }).then(
      () => undefined,
      (failure: Error) => failure,
    );
    // The end of the message carries the retry hint, or shows that there is none.
    expect(error?.message.slice(-message(run).length)).toBe(message(run));
  });

  it.each<{ name: string; summary: string; message: string }>([
    { name: "an empty summary", summary: " \n ", message: "the summary is empty" },
    {
      name: "a summary no smaller than its range",
      summary: "x".repeat(OUTPUT.length * 3),
      message: "are not smaller than the 2 entries they replace",
    },
  ])("rejects $name", async ({ summary, message }) => {
    const { session, first } = agentRun();
    await expect(
      summarize(session, { from: first.assistant, to: first.result, summary }),
    ).rejects.toThrow(message);
  });

  it.each<{
    name: string;
    settings: Record<string, unknown>;
    ctx: Record<string, unknown>;
    limit: string;
  }>([
    {
      name: "the model's output limit",
      settings: {},
      ctx: { model: { provider: "test", id: "model", maxTokens: 50 } },
      limit: "~50",
    },
    {
      name: "a per-model compaction override",
      settings: {
        compaction: {
          reserveTokens: 1_000,
          modelOverrides: { "test/model": { reserveTokens: 100 } },
        },
      },
      ctx: {},
      limit: "~80",
    },
    {
      name: "the compaction reserve",
      settings: { compaction: { reserveTokens: 200 } },
      ctx: {},
      limit: "~160",
    },
  ])(
    "caps summaries at Pi's compaction-summary budget from $name",
    async ({ settings, ctx, limit }) => {
      setPiSettings(settings);
      const { session, first, third } = agentRun();
      await expect(
        summarize(
          session,
          { from: first.assistant, to: third.result, summary: "y".repeat(1_000) },
          ctx,
        ),
      ).rejects.toThrow(`the limit is ${limit}, Pi's compaction-summary budget`);
    },
  );
});

describe("summarize edges", () => {
  it("uses Pi's default compaction reserve without a model", async () => {
    const { session, first, third } = agentRun();
    await expect(
      summarize(
        session,
        { from: first.assistant, to: third.result, summary: "z".repeat(60_000) },
        { model: undefined },
      ),
    ).rejects.toThrow("the limit is ~13.1K, Pi's compaction-summary budget");
  });
});
