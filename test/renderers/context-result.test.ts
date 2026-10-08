import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { display } from "../../src/shared/json-budget.js";
import { cleanupHarness, setupHarness, tool } from "../support/extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

const render = (value: unknown, expanded: boolean, width = 120) =>
  (
    tool
      .renderResult?.(
        { content: [{ type: "text", text: display(value) }], details: { value, truncated: false } },
        { expanded, isPartial: false },
        theme,
        { isError: false, args: {} },
      )
      .render(width) ?? []
  ).map((line) => stripTerminalSequences(line).trimEnd());

const receipt = (overrides: Record<string, unknown> = {}) => ({
  status: "staged",
  appliesAt: "turn_end",
  operation: "elide",
  targets: ["a1b2c3d4"],
  estimatedTokensFreed: 2_040,
  estimatedReprefillTokens: 5_100,
  cacheMode: "breakpoints",
  ...overrides,
});

const OUTLINE = {
  leafId: "f6f6f6f6",
  contextTokens: 7_269,
  contextWindow: 128_000,
  estimatedTokens: 2_196,
  entries: [
    {
      id: "c46d3aa5",
      role: "user",
      tokens: 4,
      reprefillTokens: 2_196,
      state: "original",
      editable: false,
      protectedReason: "user message",
      preview: "context-setup",
    },
    {
      id: "5920040a",
      role: "toolResult",
      tool: "typescript",
      tokens: 2_064,
      reprefillTokens: 2_104,
      state: "original",
      editable: true,
      pending: "elide",
      preview: "build log line 1",
    },
    {
      id: "9a9a9a9a",
      role: "note",
      key: "progress",
      tokens: 27,
      reprefillTokens: 40,
      state: "original",
      editable: false,
      protectedReason: "model note; use session.setNote",
      preview: "",
    },
  ],
  nextAfter: "9a9a9a9a",
  omitted: 3,
};

describe("context result rendering", () => {
  it.each<{ name: string; value: unknown; collapsed: string }>([
    {
      name: "an elision",
      value: receipt(),
      collapsed: "Staged elide of 1 tool result · ~2K tokens freed · applies after this turn",
    },
    {
      name: "a summary",
      value: receipt({
        operation: "summarize",
        targets: ["a", "b", "c", "d"],
        summarizedEntries: 4,
        summaryTokens: 12,
      }),
      collapsed: "Staged summary of 4 entries · ~2K tokens freed · applies after this turn",
    },
    {
      name: "a note",
      value: receipt({
        operation: "note",
        targets: ["note:progress"],
        key: "progress",
        action: "created",
        estimatedTokensFreed: -27,
      }),
      collapsed: 'Staged note "progress" created · ~27 tokens added · applies after this turn',
    },
    {
      name: "a deferred elision",
      value: receipt({ appliesAt: "run_end" }),
      collapsed: "Staged elide of 1 tool result · ~2K tokens freed · applies when the run ends",
    },
  ])("says $name is staged, not applied", ({ value, collapsed }) => {
    expect(render(value, false).join("\n")).toContain(collapsed);
  });

  it("keeps every receipt field inspectable when expanded", () => {
    const rows = render(
      receipt({
        operation: "summarize",
        targets: ["a", "b"],
        summarizedEntries: 2,
        summaryTokens: 12,
      }),
      true,
    ).join("\n");
    expect(rows).toContain(
      "Staged summary of 2 entries · ~2K tokens freed · applies after this turn",
    );
    expect(rows).toContain("targets: a, b");
    expect(rows).toContain("re-prefill: ~5.1K tokens");
    expect(rows).toContain("summary: ~12 tokens");
  });

  it.each<{ name: string; overrides: Record<string, unknown>; line: string }>([
    {
      name: "a breakpoint cache",
      overrides: { cacheMode: "breakpoints" },
      line: "re-prefill: ~5.1K tokens · whole conversation (breakpoint cache)",
    },
    {
      name: "a prefix cache",
      overrides: { cacheMode: "prefix" },
      line: "re-prefill: ~5.1K tokens · from the edited entry (prefix cache)",
    },
    {
      name: "an unknown cache",
      overrides: { cacheMode: "unknown" },
      line: "re-prefill: ~5.1K tokens · upper bound (unknown cache)",
    },
    {
      name: "a new note, which only appends",
      overrides: {
        cacheMode: "breakpoints",
        operation: "note",
        targets: ["note:k"],
        key: "k",
        action: "created",
      },
      line: "re-prefill: ~5.1K tokens",
    },
  ])("names the re-prefill basis of a receipt for $name", ({ overrides, line }) => {
    const rows = render(receipt(overrides), true);
    expect(rows.find((row) => row.includes("re-prefill:"))?.trim()).toBe(line);
  });

  it("names the old note entries a change drops, and its basis, only when it drops some", () => {
    const dropping = render(
      receipt({
        cacheMode: "breakpoints",
        operation: "note",
        targets: ["note:k"],
        key: "k",
        action: "replaced",
        droppedEntries: 2,
      }),
      true,
    );
    expect(dropping.join("\n")).toContain('note "k" replaced, dropping 2 old note entries');
    expect(dropping.find((row) => row.includes("re-prefill:"))).toContain("whole conversation");
    const appending = render(
      receipt({
        cacheMode: "breakpoints",
        operation: "note",
        targets: ["note:k"],
        key: "k",
        action: "replaced",
      }),
      true,
    );
    expect(appending.find((row) => row.includes("re-prefill:"))?.trim()).toBe(
      "re-prefill: ~5.1K tokens",
    );
  });

  it("marks superseded notes in the outline", () => {
    const outline = {
      ...OUTLINE,
      entries: OUTLINE.entries.map((entry: any) =>
        entry.role === "note" ? { ...entry, superseded: true } : entry,
      ),
    };
    expect(render(outline, true)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('9a9a9a9a note "progress" superseded · 27 tokens'),
      ]),
    );
  });

  it("names the outline's re-prefill basis once, below its entries", () => {
    const rows = render({ ...OUTLINE, cacheMode: "breakpoints" }, true);
    expect(rows.filter((row) => row.includes("whole conversation"))).toEqual([
      expect.stringContaining("re-prefill: whole conversation (breakpoint cache)"),
    ]);
  });

  it.each<{ name: string; cache: Record<string, unknown>; line: string }>([
    {
      name: "a warm cache",
      cache: { state: "warm", idleSeconds: 45, ttlSeconds: 270, refreshedBy: "request" },
      line: "cache: warm · idle 45s of 4m 30s",
    },
    {
      name: "a cache that expired after Pi refreshed it",
      cache: { state: "cold", idleSeconds: 400, ttlSeconds: 300, refreshedBy: "warming" },
      line: "cache: cold · idle 6m 40s of 5m since Pi refreshed it",
    },
    {
      name: "an unknown lifetime",
      cache: { state: "unknown", idleSeconds: 7260, ttlSeconds: null, refreshedBy: "request" },
      line: "cache: unknown lifetime · idle 2h 1m",
    },
    {
      name: "nothing cached since a compaction, a model change, or the session start",
      cache: { state: "cold", idleSeconds: null, ttlSeconds: 300, refreshedBy: null },
      line: "cache: cold · nothing cached yet",
    },
  ])("states the outline's prompt-cache state for $name", ({ cache, line }) => {
    const rows = render({ ...OUTLINE, cache }, true);
    expect(rows.find((row) => row.includes("cache:"))?.trim()).toBe(line);
  });

  it("summarizes an outline and lists one row per entry when expanded", () => {
    expect(render(OUTLINE, false).join("\n")).toContain(
      "Context: 3 entries · ~2.2K tokens listed · 7.3K of 128K in context · 3 more",
    );
    const rows = render(OUTLINE, true);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "c46d3aa5 user · 4 tokens · re-prefill 2.2K · original · protected: user message",
        ),
        expect.stringContaining("  context-setup"),
        expect.stringContaining(
          "5920040a toolResult typescript · 2.1K tokens · re-prefill 2.1K · original · pending elide",
        ),
        expect.stringContaining('9a9a9a9a note "progress" · 27 tokens'),
        expect.stringContaining("leaf: f6f6f6f6"),
        expect.stringContaining("next page: after 9a9a9a9a"),
      ]),
    );
  });

  it("reports unknown usage without inventing it", () => {
    const collapsed = render(
      {
        ...OUTLINE,
        contextTokens: null,
        contextWindow: null,
        omitted: 0,
        nextAfter: undefined,
        leafId: null,
      },
      false,
    ).join("\n");
    expect(collapsed).toContain("Context: 3 entries · ~2.2K tokens listed");
    expect(collapsed).not.toContain("in context");
    const partial = render({ ...OUTLINE, contextWindow: null }, false).join("\n");
    expect(partial).toContain("· 7.3K in context ·");
    expect(render({ ...OUTLINE, leafId: null }, true).join("\n")).toContain("leaf: none");
  });

  it("summarizes live notes against their budget", () => {
    const listing = {
      notes: [
        { key: "progress", entryId: "9a9a9a9a", tokens: 27, pending: true },
        { key: "plan", entryId: "8b8b8b8b", tokens: 93 },
      ],
      tokens: 120,
      budgetTokens: 12_800,
      maxNotes: 32,
    };
    expect(render(listing, false).join("\n")).toContain(
      "Context: 2 live notes · ~120 of ~12.8K note tokens",
    );
    const rows = render(listing, true).join("\n");
    expect(rows).toContain("progress · 9a9a9a9a · ~27 tokens · change staged");
    expect(rows).toContain("plan · 8b8b8b8b · ~93 tokens");
    expect(rows).toContain("limit: 32 notes");
    // Superseded versions count against the same budget.
    expect(render({ ...listing, supersededTokens: 600 }, false).join("\n")).toContain(
      "Context: 2 live notes · ~120 + ~600 superseded of ~12.8K note tokens",
    );
  });

  it("leaves near-miss shapes to the faithful generic view", () => {
    expect(render({ ...receipt(), extra: "EXTRA_SENTINEL" }, false).join("\n")).toContain(
      "Returned 8 fields",
    );
    expect(render({ ...receipt(), extra: "EXTRA_SENTINEL" }, true).join("\n")).toContain(
      "EXTRA_SENTINEL",
    );
  });

  it.each([60, 80, 120])("fits expanded outline rows in %i columns", (width) => {
    const long = {
      ...OUTLINE,
      entries: OUTLINE.entries.map((entry) =>
        Object.assign({}, entry, { preview: "x".repeat(300) }),
      ),
    };
    for (const row of render(long, true, width))
      expect(visibleWidth(row)).toBeLessThanOrEqual(width);
  });
});
