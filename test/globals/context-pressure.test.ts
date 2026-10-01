import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { endTurn, SessionBuilder } from "../support/context-session.js";
import {
  cleanupHarness,
  context,
  getActiveTools,
  runWithParams,
  setupHarness,
} from "../support/extension-fixture.js";

beforeEach(async () => {
  await setupHarness();
  getActiveTools.mockReturnValue(["typescript"]);
});
afterEach(cleanupHarness);

const usage = (percent: number | null, tokens: number | null = (percent ?? 0) * 2_000) => ({
  getContextUsage: () => ({ tokens, contextWindow: 200_000, percent }),
});

const OUTPUT = "solver output line\n".repeat(60);

function agentRun() {
  const session = new SessionBuilder();
  session.user("Optimize the solver");
  session.turn("bash", OUTPUT);
  session.current();
  return session;
}

const notices = (session: SessionBuilder) =>
  session.manager
    .buildSessionContext()
    .messages.filter((message: any) => message.customType === "pit.context-pressure")
    .map((message: any) => message.details.level);

describe("context pressure notices", () => {
  it("notices once when usage crosses 50% and again at 75%", async () => {
    const session = agentRun();

    const first = await endTurn(session, { ctx: usage(52) });
    expect(first).toEqual([
      {
        type: "custom_message",
        customType: "pit.context-pressure",
        content:
          "[Pit] Context is 52% full (~104K of 200K tokens). Use session.outline() to find stale tool results for session.elide() or finished turns for session.summarize(), and keep task state in session.setNote().",
        display: true,
        details: {
          level: 50,
          percent: 52,
          tokens: 104_000,
          contextWindow: 200_000,
          threshold: "50%",
          thresholdTokens: 100_000,
        },
      },
    ]);

    session.current();
    expect(await endTurn(session, { ctx: usage(60) })).toEqual([]);
    session.current();
    await endTurn(session, { ctx: usage(76.4) });

    // Earlier notices stay: omitting one mid-context would re-prefill what follows it.
    expect(notices(session)).toEqual([50, 75]);
  });

  it.each<{
    name: string;
    setup: (session: SessionBuilder) => Promise<unknown> | unknown;
    ctx: Record<string, unknown>;
    outcome?: "aborted";
  }>([
    { name: "below 50%", setup: () => undefined, ctx: usage(49.9) },
    { name: "when usage is unknown", setup: () => undefined, ctx: usage(null, null) },
    { name: "after an aborted turn", setup: () => undefined, ctx: usage(80), outcome: "aborted" },
    {
      name: "without the TypeScript tool",
      setup: () => getActiveTools.mockReturnValue([]),
      ctx: usage(80),
    },
    {
      name: "while the turn applies context edits",
      setup: (session) => {
        const id = session.manager
          .getBranch()
          .find((entry: any) => entry.message?.role === "toolResult")?.id;
        return runWithParams(
          "async ({ session: { elide } }, id: string) => elide([id])",
          id,
          context({ sessionManager: session.manager }),
        );
      },
      ctx: usage(80),
    },
  ])("adds no notice $name", async ({ setup, ctx, outcome }) => {
    const session = agentRun();
    await setup(session);

    const entries = await endTurn(session, { ctx, ...(outcome ? { outcome } : {}) });

    expect(entries.filter((entry) => entry.type === "custom_message")).toEqual([]);
  });

  // Pit's 50% notice fired at ~644K of a 1.05M window in #205's acceptance run.
  it("notices at 200K tokens in a large window, before 50% and 75%", async () => {
    const session = agentRun();
    const large = (tokens: number) => ({
      getContextUsage: () => ({
        tokens,
        contextWindow: 1_050_000,
        percent: (100 * tokens) / 1_050_000,
      }),
    });

    expect(await endTurn(session, { ctx: large(199_000) })).toEqual([]);
    session.current();
    const [first] = await endTurn(session, { ctx: large(210_000) });
    expect(first).toMatchObject({
      content: expect.stringMatching(/^\[Pit\] Context is 20% full \(~210K of 1\.1M tokens\)/),
      details: {
        level: 19,
        percent: 20,
        tokens: 210_000,
        threshold: "200K",
        thresholdTokens: 200_000,
      },
    });
    session.current();
    expect(await endTurn(session, { ctx: large(400_000) })).toEqual([]);
    session.current();
    await endTurn(session, { ctx: large(530_000) });
    session.current();
    await endTurn(session, { ctx: large(800_000) });

    expect(notices(session)).toEqual([19, 50, 75]);
  });

  it.each([
    { name: "a window where 200K is 50%", contextWindow: 400_000 },
    { name: "a small window", contextWindow: 128_000 },
  ])("adds no 200K notice in $name", async ({ contextWindow }) => {
    const session = agentRun();
    const ctx = {
      getContextUsage: () => ({
        tokens: 0.49 * contextWindow,
        contextWindow,
        percent: 49,
      }),
    };

    expect(await endTurn(session, { ctx })).toEqual([]);
  });

  it("counts a notice from before thresholds were recorded at its percentage", async () => {
    const session = agentRun();
    // Pit 0.23 recorded only the percentage level.
    session.manager.appendCustomMessageEntry(
      "pit.context-pressure",
      "[Pit] Context is 51% full.",
      true,
      {
        level: 50,
        percent: 51,
        tokens: 535_000,
        contextWindow: 1_050_000,
      },
    );
    session.current();
    const ctx = {
      getContextUsage: () => ({ tokens: 560_000, contextWindow: 1_050_000, percent: 53 }),
    };

    // The visible 50% notice already covers the lower 200K threshold.
    expect(await endTurn(session, { ctx })).toEqual([]);
  });

  it("notices again once a compaction removes the earlier notice", async () => {
    const session = agentRun();
    await endTurn(session, { ctx: usage(52) });
    const kept = session.user("Continue");
    session.manager.appendCompaction("summary", kept, 100_000);
    session.current();

    await endTurn(session, { ctx: usage(55) });

    expect(notices(session)).toEqual([50]);
    expect(
      session.manager
        .getBranch()
        .filter((entry: any) => entry.customType === "pit.context-pressure"),
    ).toHaveLength(2);
  });

  it("lets a summary fold notices inside its range", async () => {
    const session = new SessionBuilder();
    session.user("Optimize the solver");
    const first = session.turn("bash", OUTPUT);
    session.current();
    await endTurn(session, { ctx: usage(52) });
    const second = session.turn("bash", OUTPUT);
    session.current();

    await runWithParams(
      "async ({ session: { summarize } }, input: { from: string; to: string }) => summarize({ ...input, summary: 'Two benchmark runs.' })",
      { from: first.assistant, to: second.result },
      context({ sessionManager: session.manager }),
    );
    await endTurn(session);

    expect(notices(session)).toEqual([]);

    // An omitted notice no longer counts, so its level can notice again.
    session.current();
    const entries = await endTurn(session, { ctx: usage(53) });
    expect(entries.map((entry: any) => entry.customType)).toEqual(["pit.context-pressure"]);
  });
});
