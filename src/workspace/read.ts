import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";

import { recordValue as object } from "../shared/argument-values.js";
import { LIMITS, sliceText } from "../shared/bounds.js";
import { resolveWorkspacePath, workspaceResultPath } from "./paths.js";

export type WorkspaceReadFormat = "hashed" | "raw";

interface WorkspaceReadRequest {
  path: string;
  format: WorkspaceReadFormat;
  offset: number;
  limit: number;
}

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

  constructor(
    private readonly offset: number,
    limit: number,
    private readonly maximumCaptureCharacters = LIMITS.result.maxBytes + 1,
  ) {
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
  const offset = Number(options.offset ?? 1);
  const limit = Number(options.limit ?? LIMITS.result.maxLines);
  if (!Number.isInteger(offset) || offset < 1 || !Number.isInteger(limit) || limit < 1) {
    throw new Error("offset and limit must be positive integers");
  }
  return { path, format, offset, limit };
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
  const content = request.format === "hashed" ? hashedContent(scan, request.offset) : scan.selected;
  // A partial hashed line would carry the anchor of the whole line, so hashed reads keep whole lines.
  const result = sliceText(
    content,
    { maxBytes: LIMITS.result.maxBytes, maxLines: request.limit },
    "head",
    { partialLine: request.format === "raw" },
  );
  let returnedLines =
    result.text === "" ? (scan.selectedHashes.length > 0 ? 1 : 0) : Math.max(1, result.lines);
  if (request.format === "raw" && result.text.endsWith("\n")) {
    returnedLines++;
  }
  const hasMore = request.offset + request.limit - 1 < scan.totalLines;
  const truncated = result.truncated || scan.selectionTruncated;
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

export async function readWorkspace(cwd: string, args: unknown[], signal?: AbortSignal) {
  const request = parseReadRequest(cwd, args);
  const scanner = new WorkspaceReadScanner(request.offset, request.limit);
  const stream = createReadStream(request.path, { encoding: "utf8", signal });
  for await (const chunk of stream) {
    scanner.push(String(chunk));
  }
  return readResult(cwd, request, scanner.finish());
}
