import { createHash } from "node:crypto";

const ANCHOR_PATTERN = /^([1-9][0-9]*):([A-Za-z0-9_-]{5})$/;
const NEWLINE_PATTERN = /\r\n|\n|\r/g;
const LINE_HASH_LENGTH = 5;
const REVISION_HASH_LENGTH = 12;

export interface FileLine {
  number: number;
  content: string;
  start: number;
  contentEnd: number;
  separator: string;
  separatorEnd: number;
  anchor: string;
}

export type EditChange =
  | { kind: "replace"; start: string; end?: string; content: string }
  | { kind: "delete"; start: string; end?: string }
  | { kind: "insertBefore" | "insertAfter"; anchor: string; content: string }
  | { kind: "replaceFile"; content: string }
  | { kind: "deleteFile" };

export interface EditChangeSpec {
  revision: string | null;
  changes: EditChange[];
}

export interface PreparedEdit {
  next?: string;
  deleted: boolean;
  applied: number;
}

interface Replacement {
  start: number;
  end: number;
  content: string;
  index: number;
}

function digest(value: string | Buffer, length: number): string {
  return createHash("sha256").update(value).digest("base64url").slice(0, length);
}

export function lineHash(content: string): string {
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

export function lineEnding(lines: readonly FileLine[]): "lf" | "crlf" | "mixed" | "none" {
  let lf = false;
  let crlf = false;
  for (const line of lines) {
    if (line.separator === "\n") {
      lf = true;
    }
    if (line.separator === "\r\n") {
      crlf = true;
    }
  }
  if (lf && crlf) {
    return "mixed";
  }
  if (crlf) {
    return "crlf";
  }
  if (lf) {
    return "lf";
  }
  return "none";
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

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  return value;
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
  return { revision: value.revision, changes } as EditChangeSpec;
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

function prepareAnchoredEdit(contents: string, changes: EditChange[]): PreparedEdit {
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
      if (replacementsConflict(replacements[left]!, replacements[right]!)) {
        throw new Error(
          `changes.changes[${replacements[left]?.index}] overlaps changes.changes[${replacements[right]?.index}]`,
        );
      }
    }
  }
  let next = contents;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    next = next.slice(0, replacement.start) + replacement.content + next.slice(replacement.end);
  }
  return { next, deleted: false, applied: changes.length };
}

export function prepareEdit(current: string | undefined, raw: unknown): PreparedEdit {
  const spec = parseSpec(raw);
  if (current === undefined) {
    if (spec.revision !== null) {
      throw new Error("file is missing; use revision: null to create it");
    }
    if (spec.changes.length !== 1 || spec.changes[0]?.kind !== "replaceFile") {
      throw new Error("creating a file requires exactly one replaceFile change");
    }
    return { next: spec.changes[0].content, deleted: false, applied: 1 };
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
      return { next: change.content, deleted: false, applied: 1 };
    }
    return { deleted: true, applied: 1 };
  }
  return prepareAnchoredEdit(current, spec.changes);
}
