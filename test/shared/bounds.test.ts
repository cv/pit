import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  LIMITS,
  boundText,
  clipText,
  completeUtf8Length,
  sliceText,
  TextCapture,
  type BoundKeep,
  type SliceKeep,
  type TextBudget,
} from "../../src/shared/bounds.js";

const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index}`);
const lineCount = (text: string) => (text === "" ? 0 : text.split("\n").length);

describe("LIMITS", () => {
  it("matches Pi's tool-output budget", () => {
    expect(LIMITS.result).toEqual({ maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  });
});

describe("sliceText", () => {
  it.each<{
    name: string;
    text: string;
    budget: TextBudget;
    keep: SliceKeep;
    partialLine?: boolean;
    expected: string;
    truncated: boolean;
  }>([
    {
      name: "text within budget unchanged",
      text: "one\ntwo\n",
      budget: { maxBytes: 100, maxLines: 5 },
      keep: "head",
      expected: "one\ntwo\n",
      truncated: false,
    },
    {
      name: "leading lines by line limit",
      text: "one\ntwo\nthree\nfour",
      budget: { maxBytes: 100, maxLines: 2 },
      keep: "head",
      expected: "one\ntwo",
      truncated: true,
    },
    {
      name: "trailing lines by byte limit",
      text: "one\ntwo\nthree\nfour",
      budget: { maxBytes: 10 },
      keep: "tail",
      expected: "three\nfour",
      truncated: true,
    },
    {
      name: "an exact suffix, including the trailing newline",
      text: "a\nb\nc\n",
      budget: { maxBytes: 100, maxLines: 2 },
      keep: "tail",
      expected: "b\nc\n",
      truncated: true,
    },
    {
      name: "a character-safe prefix of an over-long first line",
      text: `${"é".repeat(10)}\nnext`,
      budget: { maxBytes: 5 },
      keep: "head",
      expected: "éé",
      truncated: true,
    },
    {
      name: "a character-safe suffix of an over-long last line",
      text: `first\n${"é".repeat(10)}`,
      budget: { maxBytes: 5 },
      keep: "tail",
      expected: "éé",
      truncated: true,
    },
    {
      name: "nothing when the budget cannot hold one character",
      text: "éé",
      budget: { maxBytes: 1 },
      keep: "head",
      expected: "",
      truncated: true,
    },
    {
      name: "nothing when partial lines are refused",
      text: "x".repeat(20),
      budget: { maxBytes: 5 },
      keep: "head",
      partialLine: false,
      expected: "",
      truncated: true,
    },
  ])("keeps $name", ({ text, budget, keep, partialLine, expected, truncated }) => {
    const slice = sliceText(text, budget, keep, partialLine === undefined ? {} : { partialLine });
    expect(slice).toMatchObject({ text: expected, truncated });
    expect(Buffer.byteLength(slice.text)).toBeLessThanOrEqual(budget.maxBytes);
  });
});

describe("boundText", () => {
  const text = lines(100).join("\n");
  const budget = { maxBytes: 200, maxLines: 10 };

  it.each<{ keep: BoundKeep; first: string; last: string }>([
    { keep: "head", first: "line 0", last: "marker" },
    { keep: "tail", first: "marker", last: "line 99" },
    { keep: "ends", first: "line 0", last: "line 99" },
  ])("marks counted omissions within the budget when keeping $keep", ({ keep, first, last }) => {
    const bounded = boundText(text, budget, keep);
    const rows = bounded.text.split("\n");
    const marker = rows.find((row) => row.includes("omitted"));
    const kept = rows.filter((row) => row !== marker);

    expect(bounded.truncated).toBe(true);
    expect(Buffer.byteLength(bounded.text)).toBeLessThanOrEqual(budget.maxBytes);
    expect(rows.length).toBeLessThanOrEqual(budget.maxLines);
    expect(marker).toBe(`… ${100 - kept.length} lines omitted …`);
    expect([rows[0], rows.at(-1)].map((row) => (row === marker ? "marker" : row))).toEqual([
      first,
      last,
    ]);
  });

  it("marks omitted bytes when both ends of one long line are kept", () => {
    const bounded = boundText("a".repeat(500) + "b".repeat(500), { maxBytes: 100 }, "ends");
    const [head, marker, tail] = bounded.text.split("\n");
    const omitted = 1000 - (head?.length ?? 0) - (tail?.length ?? 0);

    expect(Buffer.byteLength(bounded.text)).toBeLessThanOrEqual(100);
    expect(head).toMatch(/^a+$/);
    expect(tail).toMatch(/^b+$/);
    expect(marker).toBe(`… ${omitted} bytes omitted …`);
  });

  it("folds a marker at the tail edge into one exact count", () => {
    // An earlier head bound leaves its marker directly above a footer the outer bound keeps.
    const inner = boundText(lines(500).join("\n"), { maxBytes: 100_000, maxLines: 11 }, "head");
    const rows = boundText(
      `${inner.text}\nfooter`,
      { maxBytes: 2_000, maxLines: 5 },
      "ends",
    ).text.split("\n");
    const shown = rows.filter((row) => row.startsWith("line "));

    expect(rows.filter((row) => row.includes("omitted"))).toEqual([
      `… ${500 - shown.length} lines omitted …`,
    ]);
    expect(rows.at(-1)).toBe("footer");
  });

  it("keeps one exact count through stacked bounds", () => {
    // A raised process error bounds stderr, failure details bound the error, and the collapsed
    // preview bounds the details; every earlier marker folds into the outermost count.
    const stderr = `${lines(500).join("\n")}\n`;
    const raised = `Command failed\n${boundText(stderr, LIMITS.processError, "tail").text}`;
    const failure = boundText(raised, LIMITS.failure, "ends").text;
    const rows = boundText(failure, LIMITS.failurePreview, "ends").text.split("\n");
    const shown = rows.filter((row) => row.startsWith("line "));

    expect(rows.filter((row) => row.includes("omitted"))).toEqual([
      `… ${500 - shown.length} lines omitted …`,
    ]);
    expect(rows[0]).toBe("Command failed");
    expect(shown.at(-1)).toBe("line 499");
  });

  it("returns text within budget unchanged", () => {
    expect(boundText("short\n", budget, "ends")).toEqual({ text: "short\n", truncated: false });
  });
});

describe("character-safe cutting", () => {
  it("never ends a byte prefix inside a UTF-8 sequence", () => {
    const text = "aé€😀z";
    const bytes = Buffer.from(text);
    for (let end = 0; end <= bytes.length; end++) {
      const prefix = bytes.subarray(0, end);
      const decoded = prefix.subarray(0, completeUtf8Length(prefix)).toString("utf8");
      expect(decoded).not.toContain("\uFFFD");
      expect(text.startsWith(decoded)).toBe(true);
    }
  });

  it.each<{ text: string; max: number; expected: string }>([
    { text: "short", max: 10, expected: "short" },
    { text: "abcdef", max: 4, expected: "abc…" },
    { text: "a😀b", max: 3, expected: "a…" },
  ])("clips $text to $max characters", ({ text, max, expected }) => {
    expect(clipText(text, max)).toBe(expected);
  });
});

describe("TextCapture", () => {
  // Chunk boundaries fall inside multi-byte characters and lines.
  const source = lines(400)
    .map((line, index) => (index % 7 === 0 ? `${line} é€😀` : line))
    .join("\n");
  const bytes = Buffer.from(source);
  const chunks: Buffer[] = [];
  for (let offset = 0, size = 1; offset < bytes.length; offset += size, size = (size % 97) + 13) {
    chunks.push(bytes.subarray(offset, offset + size));
  }

  it.each<{ keep: SliceKeep; budget: TextBudget }>([
    { keep: "head", budget: { maxBytes: 300, maxLines: 1000 } },
    { keep: "head", budget: { maxBytes: 100_000, maxLines: 25 } },
    { keep: "tail", budget: { maxBytes: 300, maxLines: 1000 } },
    { keep: "tail", budget: { maxBytes: 100_000, maxLines: 25 } },
    { keep: "tail", budget: { maxBytes: 100_000, maxLines: 1000 } },
  ])(
    "matches slicing the complete output: $keep, $budget.maxBytes bytes, $budget.maxLines lines",
    ({ keep, budget }) => {
      const capture = new TextCapture(budget, keep);
      const decoded = chunks.map((chunk) => capture.push(chunk)).join("");
      const expected = sliceText(source, budget, keep);

      expect(decoded).toBe(source);
      expect(capture.finish()).toEqual({ text: expected.text, truncated: expected.truncated });
      expect(lineCount(expected.text)).toBeLessThanOrEqual(budget.maxLines ?? Infinity);
    },
  );
});
