import { StringDecoder } from "node:string_decoder";

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";

/** A text budget. Lines are counted like Pi: a trailing newline does not start another line. */
export interface TextBudget {
  maxBytes: number;
  maxLines?: number;
}

/**
 * Text budgets shared by producers and presenters. Item caps such as search results, glob
 * entries, and capability traces are domain limits and stay with their owners.
 */
export const LIMITS = {
  /** Model-visible text of one invocation result: Pi's tool-output budget. */
  result: { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES },
  /** Default and maximum capture per process stream. */
  processStream: { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES },
  /** Diagnostic excerpt embedded in a raised process error. */
  processError: { maxBytes: 4_000 },
  /** Default and maximum HTTP response body. */
  httpBody: { maxBytes: 1_000_000 },
  /** Root error text retained in structured failure details. */
  failure: { maxBytes: 8_000, maxLines: 24 },
  /** First line of a collapsed failure. */
  failureHeadline: { maxBytes: 2_000, maxLines: 1 },
  /** Live output retained per shell call for progress views. */
  shellTail: { maxBytes: 4_000, maxLines: 8 },
} as const satisfies Record<string, TextBudget>;

export type SliceKeep = "head" | "tail";
export type BoundKeep = SliceKeep | "ends";

export interface TextSlice {
  text: string;
  truncated: boolean;
  /** Lines in `text`, counting a partial edge line as one line. */
  lines: number;
  /** Whether `text` ends (head) or starts (tail) inside a line of the original. */
  partial: boolean;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

function countNewlines(text: string): number {
  let count = 0;
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) {
    count++;
  }
  return count;
}

function isContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function sequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  return 4;
}

/** Length of the longest prefix of `bytes` that does not end inside a UTF-8 sequence. */
export function completeUtf8Length(bytes: Uint8Array): number {
  let lead = bytes.length;
  // A sequence is at most four bytes, so only the last three can belong to an unfinished one.
  while (lead > 0 && bytes.length - lead < 3 && isContinuationByte(bytes[lead - 1] as number)) {
    lead--;
  }
  if (lead === 0) return bytes.length;
  const start = lead - 1;
  return start + sequenceLength(bytes[start] as number) > bytes.length ? start : bytes.length;
}

/** The longest prefix of `text` within `maxBytes` UTF-8 bytes that keeps every character whole. */
function utf8Prefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text).subarray(0, Math.max(0, maxBytes));
  return bytes.subarray(0, completeUtf8Length(bytes)).toString("utf8");
}

/** The longest suffix of `text` within `maxBytes` UTF-8 bytes that keeps every character whole. */
function utf8Suffix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text);
  let start = Math.max(0, bytes.length - Math.max(0, maxBytes));
  while (start < bytes.length && isContinuationByte(bytes[start] as number)) start++;
  return bytes.subarray(start).toString("utf8");
}

/**
 * Verbatim slice for data returned to guest code: whole lines within both limits, no marker.
 * When the edge line alone exceeds the byte budget, it is cut at a character boundary rather
 * than returning empty text, unless `partialLine` is false.
 */
export function sliceText(
  text: string,
  budget: TextBudget,
  keep: SliceKeep = "head",
  { partialLine = true }: { partialLine?: boolean } = {},
): TextSlice {
  const maxLines = budget.maxLines ?? Number.POSITIVE_INFINITY;
  const lines = splitLines(text);
  if (lines.length <= maxLines && Buffer.byteLength(text) <= budget.maxBytes) {
    return { text, truncated: false, lines: lines.length, partial: false };
  }
  const kept: string[] = [];
  let bytes = 0;
  for (let offset = 0; offset < lines.length && kept.length < maxLines; offset++) {
    const line = lines[keep === "head" ? offset : lines.length - 1 - offset] as string;
    const cost = Buffer.byteLength(line) + (kept.length > 0 ? 1 : 0);
    if (bytes + cost > budget.maxBytes) break;
    kept.push(line);
    bytes += cost;
  }
  if (kept.length === 0 && lines.length > 0 && maxLines >= 1 && partialLine) {
    const edge = keep === "head" ? (lines[0] as string) : (lines.at(-1) as string);
    const partial =
      keep === "head" ? utf8Prefix(edge, budget.maxBytes) : utf8Suffix(edge, budget.maxBytes);
    return { text: partial, truncated: true, lines: partial ? 1 : 0, partial: true };
  }
  if (keep === "tail") kept.reverse();
  return { text: kept.join("\n"), truncated: true, lines: kept.length, partial: false };
}

/** A counted, in-band omission marker. */
export function omissionMarker(count: number, unit: "lines" | "bytes" | "items" | "keys"): string {
  return `… ${count} ${count === 1 ? unit.slice(0, -1) : unit} omitted …`;
}

/** Splits a budget between head and tail; an unlimited budget stays unlimited on kept sides. */
function splitShare(total: number, keep: BoundKeep): [number, number] {
  if (keep === "head") return [total, 0];
  if (keep === "tail") return [0, total];
  if (!Number.isFinite(total)) return [total, total];
  const head = Math.ceil(total / 2);
  return [head, total - head];
}

/**
 * Presentation bound for text shown to the model or user: like `sliceText`, but the omission
 * is marked on its own line and the marker fits within the same budget. `ends` keeps a head and
 * a tail around the marker.
 */
export function boundText(
  text: string,
  budget: TextBudget,
  keep: BoundKeep = "head",
): { text: string; truncated: boolean } {
  const maxLines = budget.maxLines ?? Number.POSITIVE_INFINITY;
  const totalBytes = Buffer.byteLength(text);
  const totalLines = splitLines(text).length;
  if (totalLines <= maxLines && totalBytes <= budget.maxBytes) {
    return { text, truncated: false };
  }
  // Reserve the widest marker this text can need, plus its separating newlines.
  const separators = keep === "ends" ? 2 : 1;
  const contentBytes = Math.max(
    0,
    budget.maxBytes - Buffer.byteLength(omissionMarker(totalBytes, "bytes")) - separators,
  );
  const [headBytes, tailBytes] = splitShare(contentBytes, keep);
  const [headLines, tailLines] = splitShare(Math.max(0, maxLines - 1), keep);
  const empty: TextSlice = { text: "", truncated: true, lines: 0, partial: false };
  const head =
    headBytes > 0 && headLines > 0
      ? sliceText(text, { maxBytes: headBytes, maxLines: headLines }, "head")
      : empty;
  const tail =
    tailBytes > 0 && tailLines > 0
      ? sliceText(text, { maxBytes: tailBytes, maxLines: tailLines }, "tail")
      : empty;
  const marker =
    head.partial || tail.partial
      ? omissionMarker(
          totalBytes - Buffer.byteLength(head.text) - Buffer.byteLength(tail.text),
          "bytes",
        )
      : omissionMarker(totalLines - head.lines - tail.lines, "lines");
  return {
    text: [head.text, marker, tail.text].filter((part) => part !== "").join("\n"),
    truncated: true,
  };
}

/** Shortens a single-line label to `maxCharacters`, ending with `…` and keeping surrogate pairs. */
export function clipText(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) return text;
  let end = Math.max(0, maxCharacters - 1);
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
}

interface CapturedChunk {
  text: string;
  bytes: number;
  newlines: number;
}

/**
 * Streaming UTF-8 capture that retains only the window `sliceText` can return for its budget.
 * Head capture stops storing once the budget is exceeded; tail capture drops leading chunks
 * that can no longer contribute. Memory stays within the budget plus one chunk.
 */
export class TextCapture {
  readonly #decoder = new StringDecoder("utf8");
  readonly #chunks: CapturedChunk[] = [];
  #bytes = 0;
  #newlines = 0;
  #dropped = false;

  constructor(
    private readonly budget: TextBudget,
    private readonly keep: SliceKeep,
  ) {}

  /** Adds raw bytes and returns their decoded text, holding back an incomplete character. */
  push(chunk: Buffer): string {
    const text = this.#decoder.write(chunk);
    this.#append(text);
    return text;
  }

  /** Flushes the decoder and returns the bounded text. */
  finish(): { text: string; truncated: boolean } {
    this.#append(this.#decoder.end());
    const slice = sliceText(
      this.#chunks.map((chunk) => chunk.text).join(""),
      this.budget,
      this.keep,
    );
    return { text: slice.text, truncated: slice.truncated || this.#dropped };
  }

  get #exceeded(): boolean {
    return (
      this.#bytes > this.budget.maxBytes ||
      this.#newlines > (this.budget.maxLines ?? Number.POSITIVE_INFINITY)
    );
  }

  #append(text: string): void {
    if (text === "") return;
    if (this.keep === "head" && this.#exceeded) {
      // The head slice is already determined by the retained prefix.
      this.#dropped = true;
      return;
    }
    const chunk = { text, bytes: Buffer.byteLength(text), newlines: countNewlines(text) };
    this.#chunks.push(chunk);
    this.#bytes += chunk.bytes;
    this.#newlines += chunk.newlines;
    if (this.keep === "head") return;
    const maxLines = this.budget.maxLines ?? Number.POSITIVE_INFINITY;
    for (;;) {
      const first = this.#chunks[0] as CapturedChunk;
      if (this.#chunks.length === 1) break;
      // Drop only when the remainder alone still exceeds a limit, so the tail slice is unchanged.
      const remainingBytes = this.#bytes - first.bytes;
      const remainingNewlines = this.#newlines - first.newlines;
      if (!(remainingBytes > this.budget.maxBytes || remainingNewlines > maxLines)) break;
      this.#chunks.shift();
      this.#bytes = remainingBytes;
      this.#newlines = remainingNewlines;
      this.#dropped = true;
    }
  }
}
