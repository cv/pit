import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPitDurableExtension } from "../../src/durable/index.js";
import { DurableTestHost } from "../support/durable-harness.js";

let root: string;
let cwd: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pit-durable-context-"));
  cwd = join(root, "repo");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(cwd, { recursive: true }));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function host(settings?: ConstructorParameters<typeof DurableTestHost>[0]["settings"]) {
  return new DurableTestHost({
    extension: createPitDurableExtension({ agentDir: join(root, "agent") }),
    cwd,
    ...(settings ? { settings } : {}),
  });
}

const BULKY = { code: 'async () => "bulky output ".repeat(400)' };
const OTHER = { code: 'async () => "other output ".repeat(400)' };

/** A program that finds the first entry of `role` and passes it to `call`. */
function onFirst(role: string, call: string) {
  return {
    code: `async ({ session: { outline, elide, summarize } }) => {
  const [entry] = (await outline({ roles: ["${role}"] })).entries;
  return ${call};
}`,
  };
}

function texts(messages: readonly any[]): string[] {
  return messages.flatMap((message) =>
    typeof message.content === "string"
      ? [message.content]
      : message.content.flatMap((block: any) => (block.type === "text" ? [block.text] : [])),
  );
}

/** Every tool call in the context has exactly one result, and every result follows its call. */
function expectPairedToolCalls(messages: readonly any[]): void {
  const open = new Set<string>();
  const unanswered: string[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) if (block.type === "toolCall") open.add(block.id);
    }
    if (message.role === "toolResult") {
      if (!open.delete(message.toolCallId)) unanswered.push(message.toolCallId);
    }
  }
  expect({ orphanResults: unanswered, openCalls: [...open] }).toEqual({
    orphanResults: [],
    openCalls: [],
  });
}

describe("session.* on a pi-durable Harness", () => {
  it("outlines the active context and protects the user's messages and the running turn", async () => {
    const { results } = await host().run([
      BULKY,
      { code: "async ({ session: { outline } }) => outline()" },
    ]);
    const outline = results[1]?.details.value;
    expect(outline.entries.map((entry: any) => [entry.role, entry.state, entry.editable])).toEqual([
      ["user", "original", false],
      ["assistant", "original", true],
      ["toolResult", "original", true],
      ["assistant", "original", false],
    ]);
    expect(outline.entries[0].protectedReason).toBe("user message");
    expect(outline.entries[3].protectedReason).toBe("current turn");
    expect(outline.entries[2]).toMatchObject({ tool: "typescript" });
    expect(outline.entries[2].tokens).toBeGreaterThan(1000);
  });

  it("elides with when: now before the run's next request, keeping the call answered", async () => {
    const durable = host();
    const { results, requests } = await durable.run([
      BULKY,
      onFirst("toolResult", 'elide([entry.id], { reason: "absorbed", when: "now" })'),
      {
        code: 'async ({ session: { outline } }) => (await outline({ roles: ["toolResult"] })).entries[0]',
      },
    ]);
    expect(results[1]?.details.value).toMatchObject({
      status: "staged",
      appliesAt: "turn_end",
      operation: "elide",
    });
    expect(results[1]?.details.value.estimatedTokensFreed).toBeGreaterThan(1000);
    expect(results[2]?.details.value).toMatchObject({ state: "elided", editable: false });
    // The request after the elide already carries the stub.
    const third = texts(requests[2] ?? []).join("\n");
    expect(third).toContain("[Elided by the model");
    expect(third).toContain("reason: absorbed");
    expect(third).not.toContain("bulky output bulky output");
    expectPairedToolCalls(await durable.messages(await durable.root()));
  });

  it("stages an elide for the end of the run by default", async () => {
    const durable = host();
    const { results, requests } = await durable.run([
      BULKY,
      onFirst("toolResult", "elide([entry.id])"),
      {
        code: 'async ({ session: { outline } }) => (await outline({ roles: ["toolResult"] })).entries[0]',
      },
    ]);
    expect(results[1]?.details.value.appliesAt).toBe("run_end");
    expect(results[2]?.details.value).toMatchObject({ state: "original", pending: "elide" });
    expect(texts(requests.at(-1) ?? []).join("\n")).toContain("bulky output bulky output");
    // Once the run answered, the next prompt sees the stub in the result's place.
    const first = (await durable.messages(await durable.root())).find(
      (message: any) => message.role === "toolResult",
    );
    expect(texts([first]).join("")).toMatch(/^\[Elided by the model/);
  });

  it("elides a tool call into a note and drops its result, leaving every call answered", async () => {
    const durable = host();
    await durable.run([BULKY, onFirst("assistant", 'elide([entry.id], { when: "now" })')]);
    const messages = await durable.messages(await durable.root());
    const text = texts(messages).join("\n");
    expect(text).toContain("[Pit: elided tool call: typescript");
    expect(text).toContain("with its result");
    expect(text).not.toContain("bulky output bulky output");
    expectPairedToolCalls(messages);
    // The elided call itself is gone from the context; only the later elide call remains.
    const calls = messages.flatMap((message: any) =>
      message.role === "assistant"
        ? message.content.filter((block: any) => block.type === "toolCall")
        : [],
    );
    expect(calls).toHaveLength(1);
  });

  it("keeps an elided entry's original readable through inspectEntry", async () => {
    const { results } = await host().run([
      BULKY,
      onFirst("toolResult", 'elide([entry.id], { when: "now" })'),
      {
        code: `async ({ session: { outline, inspectEntry } }) => {
  const [entry] = (await outline({ roles: ["toolResult"] })).entries;
  return inspectEntry(entry.id, { limit: 40 });
}`,
      },
    ]);
    const inspected = results[2]?.details.value;
    expect(inspected).toMatchObject({ role: "toolResult", tool: "typescript", state: "elided" });
    expect(inspected.original.text).toContain("bulky output");
    expect(inspected.original.truncated).toBe(true);
    expect(inspected.visible.text).toContain("[Elided by the model");
  });

  it("summarizes a range into its first entry and omits the rest", async () => {
    const durable = host();
    const { results } = await durable.run([
      BULKY,
      OTHER,
      {
        code: `async ({ session: { outline, summarize } }) => {
  const { entries } = await outline({ roles: ["assistant", "toolResult"] });
  return summarize({ from: entries[0].id, to: entries[3].id, summary: "Two programs printed filler." });
}`,
      },
    ]);
    expect(results[2]?.details.value).toMatchObject({
      status: "staged",
      appliesAt: "turn_end",
      operation: "summarize",
      summarizedEntries: 4,
    });
    const messages = await durable.messages(await durable.root());
    const text = texts(messages).join("\n");
    expect(text).toContain("[Model summary of 4 entries");
    expect(text).toContain("Two programs printed filler.");
    expect(text).not.toContain("other output other output");
    expectPairedToolCalls(messages);
  });

  it.each([
    ["a user message", onFirst("user", "elide([entry.id])"), /cannot be edited: user message/],
    [
      "a range that splits a tool call from its result",
      {
        code: `async ({ session: { outline, summarize } }) => {
  const { entries } = await outline({ roles: ["assistant", "toolResult"] });
  return summarize({ from: entries[0].id, to: entries[0].id, summary: "x" });
}`,
      },
      /splits tool call/,
    ],
    [
      "an unknown entry",
      { code: 'async ({ session: { elide } }) => elide(["999999"])' },
      /not in the active context/,
    ],
  ])("refuses to rewrite %s", async (_name, program, message) => {
    const { results } = await host().run([BULKY, program]);
    expect(results[1]?.isError).toBe(true);
    expect(results[1]?.text).toMatch(message);
  });

  it("keeps notes in a section the next request sees, through compaction and into forks", async () => {
    const durable = host({ compaction: { keepRecentTokens: 1 } });
    const { results, requests } = await durable.run([
      { code: 'async ({ session: { setNote } }) => setNote("plan", "Ship phase two.")' },
      { code: "async ({ session: { notes } }) => notes()" },
    ]);
    expect(results[0]?.details.value).toMatchObject({
      status: "staged",
      appliesAt: "turn_end",
      operation: "note",
      key: "plan",
      action: "created",
    });
    expect(results[1]?.details.value.notes).toEqual([
      expect.objectContaining({ key: "plan", entryId: "pit_notes" }),
    ]);
    const sectionsOf = (messages: readonly any[]) =>
      messages
        .filter((message) => message.role === "system")
        .map((message) => message.sections?.pit_notes ?? "")
        .join("\n");
    expect(sectionsOf(requests[1] ?? [])).toContain('<model-note key="plan">\nShip phase two.');

    const conversation = await durable.root();
    await durable.compact(conversation, "Earlier work summarized.");
    const compacted = await durable.messages(conversation);
    expect(texts(compacted).join("\n")).toContain("Earlier work summarized.");
    const next = await durable.run([{ code: "async () => 1" }]);
    expect(sectionsOf(next.requests[0] ?? [])).toContain("Ship phase two.");

    const fork = await durable.fork(conversation);
    await durable.run(
      [{ code: 'async ({ session: { setNote } }) => setNote("plan", null)' }],
      fork,
    );
    const kept = await durable.run([{ code: "async ({ session: { notes } }) => notes()" }]);
    expect(kept.results[0]?.details.value.notes.map((note: any) => note.key)).toEqual(["plan"]);
    const forked = await durable.run([{ code: "async ({ session: { notes } }) => notes()" }], fork);
    expect(forked.results[0]?.details.value.notes).toEqual([]);
  });

  it("keeps notes within their count and token budget", async () => {
    const { results } = await host().run([
      { code: "async ({ session: { notes } }) => notes()" },
      {
        code: `async ({ session: { setNote } }) => {
  for (let index = 0; index < 32; index++) await setNote(\`key\${index}\`, "short");
  return setNote("one-more", "short");
}`,
      },
      { code: 'async ({ session: { setNote } }) => setNote("key0", "long ".repeat(20000))' },
    ]);
    expect(results[0]?.details.value).toMatchObject({ notes: [], tokens: 0, maxNotes: 32 });
    expect(results[1]?.text).toMatch(/at most 32 notes/);
    expect(results[2]?.text).toMatch(/over the ~[\d.]+K-token budget/);
  });

  it("validates note keys, content, and removals", async () => {
    const { results } = await host().run([
      { code: 'async ({ session: { setNote } }) => setNote("-bad", "x")' },
      { code: 'async ({ session: { setNote } }) => setNote("plan", "  ")' },
      { code: 'async ({ session: { setNote } }) => setNote("plan", null)' },
      { code: 'async ({ session: { setNote } }) => setNote("plan", "a")' },
      { code: 'async ({ session: { setNote } }) => setNote("plan", "b")' },
    ]);
    expect(results.slice(0, 3).map((result) => result.isError)).toEqual([true, true, true]);
    expect(results[0]?.text).toMatch(/must be 1-64 letters/);
    expect(results[2]?.text).toMatch(/No note has key "plan"/);
    expect(results[4]?.details.value.action).toBe("replaced");
  });

  it("reports the conversation in session.info", async () => {
    const { results } = await host().run([{ code: "async ({ session: { info } }) => info()" }]);
    expect(results[0]?.details.value).toMatchObject({ cache: { state: "unknown" } });
    expect(results[0]?.details.value).not.toHaveProperty("file");
    expect(results[0]?.details.value.contextTokens).toBeGreaterThan(0);
  });
});
