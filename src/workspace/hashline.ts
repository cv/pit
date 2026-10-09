import { createHash } from "node:crypto";

import { recordValue as object, stringValue as string } from "../shared/argument-values.js";
import { takeRanges, type LineRange, type RangeBudget } from "./ranges.js";

const ANCHOR_PATTERN = /^([1-9][0-9]*):([A-Za-z0-9_-]{5})$/;
const NEWLINE_PATTERN = /\r\n|\n|\r/g;
const LINE_HASH_LENGTH = 5;
const REVISION_HASH_LENGTH = 12;

interface FileLine {
  number: number;
  content: string;
  start: number;
  contentEnd: number;
  separator: string;
  separatorEnd: number;
  anchor: string;
}

type EditChange =
  | { kind: "replace"; start: string; end?: string; content: string }
  | { kind: "delete"; start: string; end?: string }
  | { kind: "insertBefore" | "insertAfter"; anchor: string; content: string }
  | { kind: "replaceFile"; content: string }
  | { kind: "deleteFile" };

interface EditChangeSpec {
  revision: string | null;
  changes: EditChange[];
  /** Lines of context to return around each change, as hashed ranges. */
  context?: number;
}

/** Hashed lines of the edited file, which a follow-up edit can anchor to without a read. */
export interface PreparedEdit {
  next?: string;
  deleted: boolean;
  applied: number;
  ranges?: LineRange[];
  rangesTruncated?: true;
}

/** Most context lines an edit may ask for on each side of a change. */
const MAX_EDIT_CONTEXT = 20;
/** Lines the returned ranges may hold for one edit, or for every edit in one batch. */
export const EDIT_RANGE_LINES = { edit: 200, batch: 400 } as const;
const EDIT_RANGE_BYTES = 32_000;

/** A fresh budget for one edit's ranges, or for every edit in one batch. */
export function rangeBudget(lines: number): RangeBudget {
  return { lines, bytes: EDIT_RANGE_BYTES };
}

/** Character spans of the new file that changes wrote, in file order. */
type Spans = ReadonlyArray<readonly [number, number]>;

interface Replacement {
  start: number;
  end: number;
  content: string;
  index: number;
}

function digest(value: string | Buffer, length: number): string {
  return createHash("sha256").update(value).digest("base64url").slice(0, length);
}

function lineHash(content: string): string {
  return digest(content, LINE_HASH_LENGTH);
}

export function fileRevision(contents: string | Buffer): string {
  return digest(contents, REVISION_HASH_LENGTH);
}

export function lineAnchor(line: number, content: string): string {
  return `${line}:${lineHash(content)}`;
}

export function parseFileLines(contents: string): FileLine[] {
  const lines: FileLine[] = [];
  let start = 0;
  let number = 1;
  for (let index = 0; index < contents.length; index++) {
    if (contents[index] !== "\n") {
      continue;
    }
    const crlf = index > start && contents[index - 1] === "\r";
    const contentEnd = crlf ? index - 1 : index;
    const content = contents.slice(start, contentEnd);
    lines.push({
      number,
      content,
      start,
      contentEnd,
      separator: crlf ? "\r\n" : "\n",
      separatorEnd: index + 1,
      anchor: lineAnchor(number, content),
    });
    start = index + 1;
    number++;
  }
  const content = contents.slice(start);
  lines.push({
    number,
    content,
    start,
    contentEnd: contents.length,
    separator: "",
    separatorEnd: contents.length,
    anchor: lineAnchor(number, content),
  });
  return lines;
}

function dominantSeparator(lines: readonly FileLine[]): "\n" | "\r\n" {
  let lf = 0;
  let crlf = 0;
  for (const line of lines) {
    if (line.separator === "\n") {
      lf++;
    }
    if (line.separator === "\r\n") {
      crlf++;
    }
  }
  return crlf > lf ? "\r\n" : "\n";
}

function parseSpec(raw: unknown): EditChangeSpec {
  const value = object(raw, "changes");
  if (!(value.revision === null || typeof value.revision === "string")) {
    throw new TypeError("changes.revision must be a string or null");
  }
  if (!Array.isArray(value.changes) || value.changes.length === 0) {
    throw new Error("changes.changes must be a non-empty array");
  }
  const changes = value.changes.map((rawChange, index): EditChange => {
    const change = object(rawChange, `changes.changes[${index}]`);
    const kind = string(change.kind, `changes.changes[${index}].kind`);
    const label = `changes.changes[${index}]`;
    switch (kind) {
      case "replace":
        return {
          kind,
          start: string(change.start, `${label}.start`),
          ...(change.end === undefined ? {} : { end: string(change.end, `${label}.end`) }),
          content: string(change.content, `${label}.content`),
        };
      case "delete":
        return {
          kind,
          start: string(change.start, `${label}.start`),
          ...(change.end === undefined ? {} : { end: string(change.end, `${label}.end`) }),
        };
      case "insertBefore":
      case "insertAfter": {
        const content = string(change.content, `${label}.content`);
        if (!content) {
          throw new Error(`${label}.content must not be empty`);
        }
        return { kind, anchor: string(change.anchor, `${label}.anchor`), content };
      }
      case "replaceFile":
        return { kind, content: string(change.content, `${label}.content`) };
      case "deleteFile":
        return { kind };
      default:
        throw new Error(`Unknown edit change kind: ${kind}`);
    }
  });
  const { context } = value;
  if (
    context !== undefined &&
    !(
      Number.isInteger(context) &&
      (context as number) >= 0 &&
      (context as number) <= MAX_EDIT_CONTEXT
    )
  ) {
    throw new TypeError(`changes.context must be an integer from 0 to ${MAX_EDIT_CONTEXT}`);
  }
  return {
    revision: value.revision,
    changes,
    ...(context === undefined ? {} : { context }),
  } as EditChangeSpec;
}

/** The index of the last line that starts at or before a character offset. */
function lineIndexAt(lines: readonly FileLine[], offset: number): number {
  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    // oxlint-disable-next-line typescript/no-non-null-assertion
    if (lines[middle]!.start <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * The edited file's hashed lines around each change, merged where they meet and bounded by the
 * budget. They carry the same anchors a read would return.
 */
function editRanges(
  next: string,
  spans: Spans,
  context: number,
  budget: RangeBudget,
): Pick<PreparedEdit, "ranges" | "rangesTruncated"> {
  const lines = parseFileLines(next);
  const windows: Array<[number, number]> = [];
  for (const [start, end] of spans) {
    const first = lineIndexAt(lines, start);
    // A deletion writes nothing; show the line now in its place.
    const last = end > start ? lineIndexAt(lines, end - 1) : first;
    const from = Math.max(0, first - context);
    const to = Math.min(lines.length - 1, last + context);
    const previous = windows.at(-1);
    if (previous && from <= previous[1] + 1) previous[1] = Math.max(previous[1], to);
    else windows.push([from, to]);
  }
  // Hashes lines lazily, so a whole-file write with context stops at the budget.
  function* hashed(from: number, to: number): Generator<string> {
    for (const line of lines.slice(from, to + 1)) yield `${line.anchor}|${line.content}`;
  }
  const { ranges, truncated } = takeRanges(
    windows.map(([from, to]) => ({ start: from + 1, lines: hashed(from, to) })),
    budget,
  );
  return { ranges, ...(truncated ? { rangesTruncated: true as const } : {}) };
}

function resolveAnchor(lines: readonly FileLine[], anchor: string, label: string): FileLine {
  const match = ANCHOR_PATTERN.exec(anchor);
  if (!match) {
    throw new Error(`${label} must be a line:hash anchor`);
  }
  const number = Number(match[1]);
  const line = lines[number - 1];
  if (!line) {
    throw new Error(`${label} references line ${number}, but the file has ${lines.length} lines`);
  }
  if (line.anchor !== anchor) {
    throw new Error(
      `Anchor mismatch at line ${number}: expected ${anchor}; current anchor is ${line.anchor}. Re-read around lines ${Math.max(1, number - 4)}-${Math.min(lines.length, number + 4)}.`,
    );
  }
  return line;
}

function normalizeContent(content: string, separator: string): string {
  return content.replace(NEWLINE_PATTERN, "\n").replaceAll("\n", separator);
}

function replacementsConflict(a: Replacement, b: Replacement): boolean {
  const aInsertion = a.start === a.end;
  const bInsertion = b.start === b.end;
  if (aInsertion && bInsertion) {
    return a.start === b.start;
  }
  if (aInsertion) {
    return a.start >= b.start && a.start <= b.end;
  }
  if (bInsertion) {
    return b.start >= a.start && b.start <= a.end;
  }
  return a.start < b.end && b.start < a.end;
}

function prepareAnchoredEdit(
  contents: string,
  changes: EditChange[],
): { next: string; spans: Spans } {
  const lines = parseFileLines(contents);
  const separator = dominantSeparator(lines);
  const replacements = changes.map((change, index): Replacement => {
    if (change.kind === "replace" || change.kind === "delete") {
      const startLine = resolveAnchor(lines, change.start, `changes.changes[${index}].start`);
      const endLine = resolveAnchor(
        lines,
        change.end ?? change.start,
        `changes.changes[${index}].end`,
      );
      if (endLine.number < startLine.number) {
        throw new Error(`changes.changes[${index}] end anchor precedes start anchor`);
      }
      if (change.kind === "replace") {
        return {
          start: startLine.start,
          end: endLine.contentEnd,
          content: normalizeContent(change.content, separator),
          index,
        };
      }
      if (endLine.separator) {
        return { start: startLine.start, end: endLine.separatorEnd, content: "", index };
      }
      const previous = lines[startLine.number - 2];
      return {
        start: previous?.contentEnd ?? startLine.start,
        end: endLine.contentEnd,
        content: "",
        index,
      };
    }
    /* v8 ignore next -- file-level kinds are rejected before anchored preparation. */
    if (change.kind === "insertBefore" || change.kind === "insertAfter") {
      const line = resolveAnchor(lines, change.anchor, `changes.changes[${index}].anchor`);
      const content = normalizeContent(change.content, separator);
      if (change.kind === "insertBefore") {
        return { start: line.start, end: line.start, content: content + separator, index };
      }
      if (line.separator) {
        return {
          start: line.separatorEnd,
          end: line.separatorEnd,
          content: content + separator,
          index,
        };
      }
      return {
        start: line.contentEnd,
        end: line.contentEnd,
        content: separator + content,
        index,
      };
    }
    /* v8 ignore next -- file-level changes are rejected before anchored preparation. */
    throw new Error(`changes.changes[${index}] file-level changes cannot be combined`);
  });
  for (let left = 0; left < replacements.length; left++) {
    for (let right = left + 1; right < replacements.length; right++) {
      // oxlint-disable-next-line typescript/no-non-null-assertion
      if (replacementsConflict(replacements[left]!, replacements[right]!)) {
        throw new Error(
          `changes.changes[${replacements[left]?.index}] overlaps changes.changes[${replacements[right]?.index}]`,
        );
      }
    }
  }
  // Where each change lands in the new file: earlier changes shift later ones.
  let shift = 0;
  const spans = [...replacements]
    .sort((a, b) => a.start - b.start)
    .map((replacement) => {
      const start = replacement.start + shift;
      shift += replacement.content.length - (replacement.end - replacement.start);
      return [start, start + replacement.content.length] as const;
    });
  let next = contents;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    next = next.slice(0, replacement.start) + replacement.content + next.slice(replacement.end);
  }
  return { next, spans };
}

/**
 * Validates and applies an edit in memory. With `context` in the spec and a budget, the result
 * carries hashed ranges of the new file around each change.
 */
export function prepareEdit(
  current: string | undefined,
  raw: unknown,
  budget?: RangeBudget,
): PreparedEdit {
  const spec = parseSpec(raw);
  const written = (next: string, spans: Spans, applied: number): PreparedEdit => ({
    next,
    deleted: false,
    applied,
    ...(spec.context === undefined || budget === undefined
      ? {}
      : editRanges(next, spans, spec.context, budget)),
  });
  if (current === undefined) {
    if (spec.revision !== null) {
      throw new Error("file is missing; use revision: null to create it");
    }
    if (spec.changes.length !== 1 || spec.changes[0]?.kind !== "replaceFile") {
      throw new Error("creating a file requires exactly one replaceFile change");
    }
    const { content } = spec.changes[0];
    return written(content, [[0, content.length]], 1);
  }
  const revision = fileRevision(current);
  if (spec.revision !== revision) {
    throw new Error(
      `Revision mismatch: expected ${spec.revision ?? "null"}; current revision is ${revision}. Re-read the file.`,
    );
  }
  const fileLevel = spec.changes.some(
    (change) => change.kind === "replaceFile" || change.kind === "deleteFile",
  );
  if (fileLevel) {
    if (spec.changes.length !== 1) {
      throw new Error("file-level changes must be the only change");
    }
    const [change] = spec.changes;
    if (change?.kind === "replaceFile") {
      return written(change.content, [[0, change.content.length]], 1);
    }
    return { deleted: true, applied: 1 };
  }
  const { next, spans } = prepareAnchoredEdit(current, spec.changes);
  return written(next, spans, spec.changes.length);
}
