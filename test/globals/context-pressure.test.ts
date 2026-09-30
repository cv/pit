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
        details: { level: 50, percent: 52, tokens: 104_000, contextWindow: 200_000 },
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
  });
});
