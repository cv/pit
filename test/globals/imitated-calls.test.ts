import type { BoundaryResult } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionBuilder } from "../support/context-session.js";
import {
  cleanupHarness,
  context,
  emit,
  getActiveTools,
  renderers,
  setupHarness,
} from "../support/extension-fixture.js";

beforeEach(async () => {
  await setupHarness();
  getActiveTools.mockReturnValue(["typescript"]);
}

// The text form a model copied in #409, where it meant to start a helper agent.
const RECORD =
  '[Pit: elided tool call: typescript · ~739 tokens with its result · reason: absorbed · originals: session.inspectEntry("3c47487c"), session.inspectEntry("7ba62e94")]';

/** Persists an assistant reply and runs Pit's turn_end handlers on it, committing their entries. */
async function finishReply(
  session: SessionBuilder,
  text: string,
  options: { call?: boolean; outcome?: "completed" | "aborted" } = {},
): Promise<BoundaryResult | undefined> {
  const { id } = session.assistant(text, options.call ? [{ name: "typescript" }] : []);
  const entry = session.manager.getEntry(id) as { message: unknown };
  const results = await emit(
    "turn_end",
    {
      type: "turn_end",
      turnIndex: 0,
      message: entry.message,
      toolResults: [],
      messageEntryId: id,
      toolResultEntryIds: [],
      entries: [],
      continue: false,
      context: {},
      outcome: options.outcome ?? "completed",
    },
    context({ sessionManager: session.manager }),
  );
  const result = results.find(Boolean) as BoundaryResult | undefined;
  for (const draft of result?.entries ?? []) {
    if (draft.type !== "custom_message") continue;
    session.manager.appendCustomMessageEntry(
      draft.customType,
      draft.content,
      draft.display,
      draft.details,
    );
  }
  return result;
}

function startedSession(): SessionBuilder {
  const session = new SessionBuilder();
  session.user("Start the review helper");
  return session;
}

describe("replies that write an elided-call record instead of a call", () => {
  it("tells the model no tool ran and asks it to make the call", async () => {
    const session = startedSession();

    const result = await finishReply(session, `Starting the helper now:\n\n${RECORD}`);

    expect(result?.continue).toBe(true);
    expect(result?.entries).toEqual([
      {
        type: "custom_message",
        customType: "pit.imitated-call",
        content: expect.stringMatching(/^\[Pit\] No tool ran: .*make the tool call now\.$/),
        display: true,
        details: { continued: true },
      },
    ]);
  });

  it("does not continue again when the reply after the notice repeats the record", async () => {
    const session = startedSession();
    await finishReply(session, RECORD);

    const repeated = await finishReply(session, `Trying again:\n${RECORD}`);

    expect(repeated?.continue).toBeUndefined();
    expect(repeated?.entries).toEqual([
      expect.objectContaining({ customType: "pit.imitated-call", details: { continued: false } }),
    ]);
    // A later, unrelated slip is a new mistake and gets its continuation.
    await finishReply(session, "Done.");
    expect((await finishReply(session, RECORD))?.continue).toBe(true);
  });

  it.each<{ name: string; text: string; call?: boolean; outcome?: "aborted" }>([
    { name: "a reply that also makes a tool call", text: RECORD, call: true },
    { name: "a record quoted inside prose", text: `The note reads ${RECORD} and means it ran.` },
    { name: "a record quoted in a code block", text: `Example:\n\`\`\`\n${RECORD}\n\`\`\`` },
    { name: "an aborted reply", text: RECORD, outcome: "aborted" },
  ])("adds no notice for $name", async ({ text, call, outcome }) => {
    const session = startedSession();

    const result = await finishReply(session, text, {
      ...(call ? { call } : {}),
      ...(outcome ? { outcome } : {}),
    });

    expect(result?.entries ?? []).toEqual([]);
    expect(result?.continue).toBeUndefined();
  });

  it.each<{ name: string; continued: boolean; summary: RegExp }>([
    { name: "a continued notice", continued: true, summary: /Pit asked the model to make the call/ },
    { name: "a repeated notice", continued: false, summary: /Pit did not ask again/ },
  ])("renders $name as a one-line warning", ({ continued, summary }) => {
    const render = renderers.get("message:pit.imitated-call");
    const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
    const message = { content: "[Pit] No tool ran: …", details: { continued } };

    const collapsed = render(message, { expanded: false }, theme).render(200).join("\n");
    const expanded = render(message, { expanded: true }, theme).render(200).join("\n");

    expect(collapsed).toMatch(/▲ No tool ran · the reply ended with an elided-call record/);
    expect(collapsed).toMatch(summary);
    expect(collapsed).not.toContain("[Pit] No tool ran");
    expect(expanded).toContain("[Pit] No tool ran: …");
  });
});
