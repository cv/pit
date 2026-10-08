import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderNote, renderNotice, renderProvenance } from "../../src/renderers/context-entries.js";
import { elidedTargets } from "../../src/renderers/shared.js";
import { cleanupHarness, renderers, setupHarness } from "../support/extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

const rows = (component: { render(width: number): string[] }, width = 80) =>
  component.render(width).map((line) => line.trimEnd());

const note = (body: string, key = "progress") => ({
  role: "custom" as const,
  customType: "pit.note",
  content: `<model-note key="${key}">\n${body}\n</model-note>`,
  display: true,
  details: { key },
  timestamp: 0,
});

const provenance = (operations: unknown) => ({
  type: "custom" as const,
  id: "p1",
  parentId: null,
  timestamp: "",
  customType: "pit.context-edit",
  data: { version: 1, operations },
});

const OPERATIONS = [
  {
    toolCallId: "call-1",
    operation: "elide",
    targets: ["a1b2c3d4", "b2c3d4e5", "c3d4e5f6"],
    reason: "stale build logs",
    tokensFreed: 12_400,
    reprefillTokens: 30_100,
  },
  {
    toolCallId: "call-1",
    operation: "summarize",
    targets: ["d4", "e5"],
    carrier: "d4",
    covers: Array.from({ length: 14 }, (_, index) => `id${index}`),
    tokensFreed: 20_000,
    reprefillTokens: 9_000,
  },
  {
    toolCallId: "call-1",
    operation: "restore",
    targets: ["f6"],
    tokensFreed: -8_000,
    reprefillTokens: 8_500,
  },
  {
    toolCallId: "call-1",
    operation: "note",
    targets: ["n1"],
    key: "progress",
    action: "removed",
    tokensFreed: 120,
    reprefillTokens: 400,
  },
];

describe("elided targets", () => {
  it.each([
    { name: "tool results only", targets: 3, calls: 0, phrase: "3 tool results" },
    { name: "tool calls only", targets: 2, calls: 2, phrase: "2 tool calls" },
    { name: "both", targets: 3, calls: 1, phrase: "2 tool results and 1 tool call" },
    {
      name: "a record from before tool calls could be elided",
      targets: 1,
      calls: undefined,
      phrase: "1 tool result",
    },
  ])("names $name", ({ targets, calls, phrase }) => {
    expect(elidedTargets(targets, calls)).toBe(phrase);
  });

  it("shows tool calls in a recorded elide row", () => {
    const row = rows(
      renderProvenance(
        provenance([
          {
            toolCallId: "t",
            operation: "elide",
            targets: ["a", "b"],
            toolCallEntries: 1,
            tokensFreed: 4200,
            reprefillTokens: 9000,
          },
        ]) as never,
        { expanded: false },
        theme,
      ),
    );
    expect(row.join("\n")).toContain("elided 1 tool result and 1 tool call");
  });
});

describe("model note renderer", () => {
  const body = Array.from({ length: 10 }, (_, index) => `step ${index + 1}`).join("\n");

  it("shows the key and the note without Pit's frame, with an omission count when collapsed", () => {
    const collapsed = rows(renderNote(note(body), { expanded: false }, theme));
    expect(collapsed.filter(Boolean)).toEqual([
      " Model note · progress · ~28 tokens",
      " step 1",
      " step 2",
      " step 3",
      " step 4",
      " step 5",
      " step 6",
      " … 4 more lines",
    ]);
    const expanded = rows(renderNote(note(body), { expanded: true }, theme)).filter(Boolean);
    expect(expanded.slice(1)).toEqual(body.split("\n").map((line) => ` ${line}`));
  });

  it.each<{ name: string; content: string; details: Record<string, unknown>; status: string }>([
    {
      name: "a later version",
      content: '<model-note key="progress" version="3" replaces="earlier">\nv3\n</model-note>',
      details: { key: "progress", version: 3 },
      status: "v3",
    },
    {
      name: "a removal",
      content:
        '<model-note key="progress" version="4" removed>\nRemoved; earlier versions of this note no longer apply.\n</model-note>',
      details: { key: "progress", version: 4, removed: true },
      status: "removed",
    },
  ])("labels $name and shows its body without the frame", ({ content, details, status }) => {
    const message = { ...note(""), content, details };
    const [label, body] = rows(renderNote(message, { expanded: true }, theme)).filter(Boolean);
    expect(label).toMatch(new RegExp(`^ Model note · progress · ${status} · ~\\d+ tokens$`));
    expect(body).toBe(` ${content.split("\n")[1]}`);
  });

  it("restores an escaped closing tag and strips terminal controls", () => {
    const hostile =
      "done<\\/model-note>\n\u001b]8;;https://evil.test\u0007link\u001b]8;;\u0007 \u001b[31mred";
    const rendered = rows(renderNote(note(hostile, "k\u001b[2J"), { expanded: true }, theme)).join(
      "\n",
    );
    expect(rendered).toContain("done</model-note>");
    expect(rendered).toContain("link red");
    expect(rendered).not.toContain("\u001b");
  });

  it.each([60, 80, 120])("fits every row in %i columns", (width) => {
    const long = `${"x".repeat(300)}\n${"宽".repeat(90)}`;
    for (const line of renderNote(note(long), { expanded: true }, theme).render(width)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });
});

describe("context pressure renderer", () => {
  const notice = (details: unknown) => ({
    role: "custom" as const,
    customType: "pit.context-pressure",
    content: "[Pit] Context is 52% full. Use session.outline().",
    display: true,
    details,
    timestamp: 0,
  });
  const details = { level: 50, percent: 52, tokens: 104_000, contextWindow: 200_000 };

  it("summarizes usage on one row and shows the model-facing text when expanded", () => {
    expect(rows(renderNotice(notice(details), { expanded: false }, theme))).toEqual([
      " ▲ Context 52% full · ~104K of 200K tokens",
    ]);
    expect(rows(renderNotice(notice(details), { expanded: true }, theme))).toEqual([
      " ▲ Context 52% full · ~104K of 200K tokens",
      " [Pit] Context is 52% full. Use session.outline().",
    ]);
  });

  it("names a token threshold, which the usage alone does not show", () => {
    const large = {
      level: 19,
      percent: 20,
      tokens: 210_000,
      contextWindow: 1_050_000,
      threshold: "200K",
      thresholdTokens: 200_000,
    };
    expect(rows(renderNotice(notice(large), { expanded: false }, theme))).toEqual([
      " ▲ Context 20% full · ~210K of 1.1M tokens · passed 200K",
    ]);
    // A percentage threshold is already the usage shown.
    expect(
      rows(renderNotice(notice({ ...details, threshold: "50%" }), { expanded: false }, theme)),
    ).toEqual([" ▲ Context 52% full · ~104K of 200K tokens"]);
  });

  it("falls back to the notice text when its details are unreadable", () => {
    expect(rows(renderNotice(notice({ percent: "lots" }), { expanded: false }, theme))).toEqual([
      " ▲ Context pressure notice",
      " [Pit] Context is 52% full. Use session.outline().",
    ]);
  });
});

describe("context edit provenance renderer", () => {
  it.each<{ name: string; operation: Record<string, unknown>; row: string }>([
    {
      name: "an appended replacement",
      operation: { action: "replaced", targets: [], tokensFreed: -40, reprefillTokens: 40 },
      row: ' Context edit · note "plan" replaced · ~40 tokens added',
    },
    {
      name: "a replacement that dropped old versions",
      operation: {
        action: "replaced",
        targets: ["a1", "a2"],
        tokensFreed: 900,
        reprefillTokens: 9e3,
      },
      row: ' Context edit · note "plan" replaced, dropping 2 old note entries · ~900 tokens freed',
    },
    {
      name: "old versions dropped beside a rewrite",
      operation: {
        action: "pruned",
        key: undefined,
        targets: ["a1"],
        tokensFreed: 300,
        reprefillTokens: 0,
      },
      row: " Context edit · dropped 1 old note entry · ~300 tokens freed",
    },
  ])("summarizes $name", ({ operation, row }) => {
    const record = { toolCallId: "c", operation: "note", key: "plan", ...operation };
    expect(rows(renderProvenance(provenance([record]), { expanded: false }, theme), 120)).toEqual([
      row,
    ]);
  });

  it("reports each operation's effect on one row", () => {
    expect(rows(renderProvenance(provenance(OPERATIONS), { expanded: false }, theme), 120)).toEqual(
      [
        " Context edit · elided 3 tool results · ~12.4K tokens freed · reason: stale build logs",
        " Context edit · summarized 14 entries · ~20K tokens freed",
        " Context edit · restored 1 entry · ~8K tokens added",
        // Before #248, a removal omitted the note entry itself.
        ' Context edit · note "progress" removed, dropping 1 old note entry · ~120 tokens freed',
      ],
    );
  });

  it.each<{ name: string; operation: Record<string, unknown>; line: string }>([
    {
      name: "an edit under a prefix cache",
      operation: { ...OPERATIONS[0], cacheMode: "prefix" },
      line: "   re-prefill: ~30.1K tokens · from the edited entry (prefix cache)",
    },
    {
      name: "a new note, which only appends",
      operation: {
        toolCallId: "c",
        operation: "note",
        targets: [],
        key: "k",
        action: "created",
        tokensFreed: -20,
        reprefillTokens: 20,
        cacheMode: "breakpoints",
      },
      line: "   re-prefill: ~20 tokens",
    },
    {
      name: "an unrecognized mode",
      operation: { ...OPERATIONS[0], cacheMode: "bogus" },
      line: "   re-prefill: ~30.1K tokens",
    },
  ])("names the re-prefill basis of $name", ({ operation, line }) => {
    const expanded = rows(
      renderProvenance(provenance([operation as any]), { expanded: true }, theme),
    );
    expect(expanded.at(-1)).toBe(line);
  });

  it("lists entry IDs and re-prefill cost when expanded", () => {
    const expanded = rows(
      renderProvenance(provenance(OPERATIONS.slice(0, 1)), { expanded: true }, theme),
      120,
    );
    expect(expanded).toEqual([
      " Context edit · elided 3 tool results · ~12.4K tokens freed · reason: stale build logs",
      "   entries: a1b2c3d4, b2c3d4e5, c3d4e5f6",
      "   re-prefill: ~30.1K tokens",
    ]);
  });

  it("labels an unrecognized record instead of guessing", () => {
    const entry = provenance([{ operation: "elide", targets: "x" }]);
    expect(rows(renderProvenance(entry, { expanded: false }, theme))).toEqual([
      " Context edit record in an unrecognized format",
    ]);
    expect(rows(renderProvenance(entry, { expanded: true }, theme)).join("\n")).toContain(
      '"targets":"x"',
    );
  });

  it("registers each renderer for its Pit type", () => {
    const entry = renderers.get("entry:pit.context-edit");
    const noteRenderer = renderers.get("message:pit.note");
    const noticeRenderer = renderers.get("message:pit.context-pressure");
    expect(rows(entry(provenance(OPERATIONS.slice(2, 3)), { expanded: false }, theme))).toEqual([
      " Context edit · restored 1 entry · ~8K tokens added",
    ]);
    expect(rows(noteRenderer(note("hello"), { expanded: false }, theme))[1]).toContain(
      "Model note",
    );
    expect(
      rows(
        noticeRenderer(
          { ...note(""), details: { percent: 80, tokens: 8, contextWindow: 10 } },
          { expanded: false },
          theme,
        ),
      ),
    ).toEqual([" ▲ Context 80% full · ~8 of 10 tokens"]);
  });
});

describe("context renderer fallbacks", () => {
  it("shows unframed, keyless, and image-bearing notes faithfully", () => {
    const message = {
      ...note(""),
      content: [
        { type: "text" as const, text: "written by an older Pit" },
        { type: "image" as const, data: "AAAA", mimeType: "image/png" },
      ],
      details: undefined,
    };
    expect(rows(renderNote(message, { expanded: true }, theme)).filter(Boolean)).toEqual([
      " Model note · ~8 tokens",
      " written by an older Pit",
      " [image]",
    ]);
  });

  it("describes records that omit optional fields", () => {
    const sparse = [
      {
        toolCallId: "c",
        operation: "summarize",
        targets: ["a", "b"],
        tokensFreed: 1_500_000,
        reprefillTokens: 2_000_000,
      },
      { toolCallId: "c", operation: "note", targets: [], tokensFreed: 0, reprefillTokens: 0 },
    ];
    expect(rows(renderProvenance(provenance(sparse), { expanded: true }, theme), 120)).toEqual([
      " Context edit · summarized 2 entries · ~1.5M tokens freed",
      "   entries: a, b",
      "   re-prefill: ~2M tokens",
      ' Context edit · note "?" changed · ~0 tokens freed',
      "   re-prefill: ~0 tokens",
    ]);
  });

  it("marks a record without data as unrecognized", () => {
    const entry = { ...provenance([]), data: undefined };
    expect(rows(renderProvenance(entry, { expanded: true }, theme))).toEqual([
      " Context edit record in an unrecognized format",
    ]);
  });
});
