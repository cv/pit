import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";

import { recordValue as object } from "../shared/argument-values.js";
import { LIMITS, sliceText } from "../shared/bounds.js";
import { resolveWorkspacePath, workspaceResultPath } from "./paths.js";
import { takeRanges } from "./ranges.js";

export type WorkspaceReadFormat = "hashed" | "raw";

interface WorkspaceReadRequest {
  path: string;
  format: WorkspaceReadFormat;
  offset: number;
  limit: number;
  /** Line ranges to read instead of one window, sorted and merged. */
  ranges?: Array<[number, number]>;
}

/** Most line ranges one read may ask for. */
export const MAX_READ_RANGES = 20;

export interface WorkspaceReadScan {
  selected: string;
  selectedHashes: string[];
  totalLines: number;
  revision: string;
  selectionTruncated: boolean;
}

export class WorkspaceReadScanner {
  readonly #selectionEnd: number;
  readonly #selectedHashes: string[] = [];
  readonly #revisionHasher = createHash("sha256");
  #lineHasher: Hash = createHash("sha256");
  #selected = "";
  #selectionTruncated = false;
  #currentLine = 1;
  #totalLines = 1;
  #pendingCarriageReturn = false;

  private readonly offset: number;
  private readonly maximumCaptureCharacters: number;

  constructor(
    offset: number,
    limit: number,
    maximumCaptureCharacters = LIMITS.result.maxBytes + 1,
  ) {
    this.offset = offset;
    this.maximumCaptureCharacters = maximumCaptureCharacters;
    this.#selectionEnd = offset + limit - 1;
  }

  push(chunk: string): void {
    this.#revisionHasher.update(chunk);
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf("\n", start);
      if (newline < 0) {
        this.#appendSegment(chunk.slice(start), false);
        return;
      }
      this.#appendSegment(chunk.slice(start, newline), true);
      this.#finishLine(true);
      this.#totalLines++;
      this.#currentLine++;
      start = newline + 1;
    }
  }

  finish(): WorkspaceReadScan {
    this.#finishLine(false);
    return {
      selected: this.#selected,
      selectedHashes: [...this.#selectedHashes],
      totalLines: this.#totalLines,
      revision: this.#revisionHasher.digest("base64url").slice(0, 12),
      selectionTruncated: this.#selectionTruncated,
    };
  }

  #selectedLine(): boolean {
    return this.#currentLine >= this.offset && this.#currentLine <= this.#selectionEnd;
  }

  #appendSegment(segment: string, hasNewline: boolean): void {
    this.#hashSegment(segment, hasNewline);
    if (!this.#selectedLine()) {
      return;
    }
    this.#appendSelected(segment);
    if (hasNewline && this.#currentLine < this.#selectionEnd) {
      this.#appendSelected("\n");
    }
  }

  #appendSelected(value: string): void {
    if (!value) {
      return;
    }
    const remaining = this.maximumCaptureCharacters - this.#selected.length;
    if (remaining <= 0) {
      this.#selectionTruncated = true;
      return;
    }
    this.#selected += value.slice(0, remaining);
    this.#selectionTruncated ||= value.length > remaining;
  }

  #hashSegment(segment: string, hasNewline: boolean): void {
    if (this.#pendingCarriageReturn) {
      if (!(hasNewline && segment === "")) {
        this.#lineHasher.update("\r");
      }
      this.#pendingCarriageReturn = false;
    }
    if (segment.endsWith("\r")) {
      this.#lineHasher.update(segment.slice(0, -1));
      this.#pendingCarriageReturn = true;
    } else {
      this.#lineHasher.update(segment);
    }
  }

  #finishLine(hasNewline: boolean): void {
    if (this.#pendingCarriageReturn) {
      if (!hasNewline) {
        this.#lineHasher.update("\r");
      }
      this.#pendingCarriageReturn = false;
    }
    if (this.#selectedLine()) {
      this.#selectedHashes.push(this.#lineHasher.digest("base64url").slice(0, 5));
    } else {
      this.#lineHasher.digest();
    }
    this.#lineHasher = createHash("sha256");
  }
}

function parseReadRequest(cwd: string, args: unknown[]): WorkspaceReadRequest {
  const path = resolveWorkspacePath(cwd, args[0]);
  const options = args[1] === undefined ? {} : object(args[1], "options");
  const format = options.format ?? "hashed";
  if (format !== "hashed" && format !== "raw") {
    throw new Error('options.format must be "hashed" or "raw"');
  }
  if (options.ranges !== undefined) {
    if (options.offset !== undefined || options.limit !== undefined) {
      throw new Error("options.ranges cannot be combined with offset or limit");
    }
    if (format !== "hashed") throw new Error("options.ranges requires the hashed format");
    return { path, format, offset: 1, limit: 1, ranges: parseRanges(options.ranges) };
  }
  const offset = Number(options.offset ?? 1);
  // Raw reads are program data: whole files by default. Hashed reads are bounded for the model.
  const limit = Number(
    options.limit ?? (format === "raw" ? Number.MAX_SAFE_INTEGER : LIMITS.result.maxLines),
  );
  if (!Number.isInteger(offset) || offset < 1 || !Number.isInteger(limit) || limit < 1) {
    throw new Error("offset and limit must be positive integers");
  }
  return { path, format, offset, limit };
}

/** Validates `[start, end]` line pairs, then sorts them and merges any that overlap or touch. */
function parseRanges(raw: unknown): Array<[number, number]> {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_READ_RANGES) {
    throw new Error(`options.ranges must be 1-${MAX_READ_RANGES} [start, end] line pairs`);
  }
  const ranges = raw.map((range: unknown, index) => {
    const [start, end] = Array.isArray(range) && range.length === 2 ? range : [];
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
      throw new Error(
        `options.ranges[${index}] must be [start, end] line numbers with 1 <= start <= end`,
      );
    }
    return [start as number, end as number] as [number, number];
  });
  ranges.sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const last = merged.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function hashedContent(scan: WorkspaceReadScan, offset: number): string {
  const selectedLines = scan.selectedHashes.length === 0 ? [] : scan.selected.split("\n");
  return selectedLines
    .slice(0, scan.selectedHashes.length)
    .map((line, index) => {
      const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
      // oxlint-disable-next-line typescript/no-non-null-assertion
      return `${offset + index}:${scan.selectedHashes[index]!}|${normalized}`;
    })
    .join("\n");
}

function readResult(cwd: string, request: WorkspaceReadRequest, scan: WorkspaceReadScan) {
  const raw = request.format === "raw";
  const content = raw ? scan.selected : hashedContent(scan, request.offset);
  const budget = raw ? LIMITS.programData : LIMITS.result;
  // A partial hashed line would carry the anchor of the whole line, so hashed reads keep whole lines.
  const result = sliceText(
    content,
    { maxBytes: budget.maxBytes, maxLines: request.limit },
    "head",
    {
      partialLine: raw,
    },
  );
  const truncated = result.truncated || scan.selectionTruncated;
  // A shortened raw read would reach parsers and writers as if it were the whole file.
  if (raw && truncated) {
    throw new Error(
      `Cannot read ${workspaceResultPath(cwd, request.path)} raw: the selection is larger than ${budget.maxBytes.toLocaleString("en-US")} bytes (the file has ${scan.totalLines.toLocaleString("en-US")} lines). Pass offset and limit to read it in parts.`,
    );
  }
  let returnedLines =
    result.text === "" ? (scan.selectedHashes.length > 0 ? 1 : 0) : Math.max(1, result.lines);
  if (raw && result.text.endsWith("\n")) {
    returnedLines++;
  }
  const hasMore = request.offset + request.limit - 1 < scan.totalLines;
  return {
    file: workspaceResultPath(cwd, request.path),
    format: request.format,
    content: result.text,
    revision: scan.revision,
    ...(request.offset === 1 ? {} : { offset: request.offset }),
    lines: returnedLines,
    ...(scan.totalLines === returnedLines ? {} : { totalLines: scan.totalLines }),
    ...(hasMore ? { hasMore: true as const } : {}),
    ...(truncated ? { truncated: true as const } : {}),
  };
}

/**
 * Reads several hashed line ranges in one pass, so they all describe one revision. They share
 * a whole-file read's line and byte budget and keep whole lines.
 */
async function readRanges(
  cwd: string,
  path: string,
  requested: Array<[number, number]>,
  signal?: AbortSignal,
) {
  const scanners = requested.map(
    ([start, end]) => new WorkspaceReadScanner(start, end - start + 1),
  );
  const stream = createReadStream(path, { encoding: "utf8", signal });
  for await (const chunk of stream) {
    for (const scanner of scanners) scanner.push(String(chunk));
  }
  const scans = scanners.map((scanner) => scanner.finish());
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const { totalLines, revision } = scans[0]!;
  const file = workspaceResultPath(cwd, path);
  const past = requested.find(([start]) => start > totalLines);
  if (past)
    throw new Error(`A range starts at line ${past[0]}, but ${file} has ${totalLines} lines`);
  // The ranges share one hashed read's line and byte budget.
  const { ranges, truncated } = takeRanges(
    scans.map((scan, index) => {
      // oxlint-disable-next-line typescript/no-non-null-assertion
      const start = requested[index]![0];
      return { start, lines: hashedContent(scan, start).split("\n"), cut: scan.selectionTruncated };
    }),
    { lines: LIMITS.result.maxLines, bytes: LIMITS.result.maxBytes },
  );
  return {
    file,
    format: "hashed" as const,
    revision,
    ranges,
    lines: ranges.reduce((sum, range) => sum + range.end - range.start + 1, 0),
    totalLines,
    ...(truncated ? { truncated: true as const } : {}),
  };
}

export async function readWorkspace(cwd: string, args: unknown[], signal?: AbortSignal) {
  const request = parseReadRequest(cwd, args);
  if (request.ranges) return readRanges(cwd, request.path, request.ranges, signal);
  const capture = request.format === "raw" ? LIMITS.programData.maxBytes + 1 : undefined;
  const scanner = new WorkspaceReadScanner(request.offset, request.limit, capture);
  const stream = createReadStream(request.path, { encoding: "utf8", signal });
  for await (const chunk of stream) {
    scanner.push(String(chunk));
  }
  return readResult(cwd, request, scanner.finish());
}
