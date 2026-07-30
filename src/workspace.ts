import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import fg from "fast-glob";
import { CAPABILITY_METHODS } from "./capability-registry.js";
import { fileRevision, lineAnchor, prepareEdit } from "./hashline.js";
import { InterruptibleRegexMatcher } from "./regex-worker.js";

const MAX_SEARCH_FILE_BYTES = 1_000_000;
const MAX_SEARCH_FILES = 2000;
const MAX_SEARCH_RESULTS = 500;
const MAX_GLOB_RESULTS = 10_000;
const AT_PATH_PREFIX = /^@/;
export const WORKSPACE_METHODS = CAPABILITY_METHODS.workspace;

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

function checkAbort(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}
export function resolveWorkspacePath(cwd: string, value: unknown): string {
  return resolve(cwd, string(value, "path").replace(AT_PATH_PREFIX, ""));
}

function workspaceResultPath(cwd: string, path: string): string {
  return relative(cwd, path).replaceAll("\\", "/");
}

function detectedLineEnding(lf: number, crlf: number): "lf" | "crlf" | "mixed" | "none" {
  if (lf > 0 && crlf > 0) {
    return "mixed";
  }
  if (crlf > 0) {
    return "crlf";
  }
  if (lf > 0) {
    return "lf";
  }
  return "none";
}

async function readWorkspace(cwd: string, args: unknown[], signal?: AbortSignal) {
  const path = resolveWorkspacePath(cwd, args[0]);
  const options = args[1] === undefined ? {} : object(args[1], "options");
  const format = options.format ?? "hashed";
  if (format !== "hashed" && format !== "raw") {
    throw new Error('options.format must be "hashed" or "raw"');
  }
  const offset = Number(options.offset ?? 1);
  const limit = Number(options.limit ?? DEFAULT_MAX_LINES);
  if (!Number.isInteger(offset) || offset < 1 || !Number.isInteger(limit) || limit < 1) {
    throw new Error("offset and limit must be positive integers");
  }

  const selectionEnd = offset + limit - 1;
  const maxCaptureCharacters = DEFAULT_MAX_BYTES + 1;
  const selectedHashes: string[] = [];
  let selected = "";
  let selectionTruncated = false;
  let currentLine = 1;
  let totalLines = 1;
  let lineHasher = createHash("sha256");
  const revisionHasher = createHash("sha256");
  let pendingCarriageReturn = false;
  const endings = { lf: 0, crlf: 0 };
  let endsWithNewline = false;
  const selectedLine = () => currentLine >= offset && currentLine <= selectionEnd;
  const appendSelected = (value: string): void => {
    if (!value) {
      return;
    }
    const remaining = maxCaptureCharacters - selected.length;
    if (remaining <= 0) {
      selectionTruncated = true;
      return;
    }
    selected += value.slice(0, remaining);
    selectionTruncated ||= value.length > remaining;
  };
  const hashSegment = (segment: string): void => {
    /* v8 ignore next 4 -- only a stream chunk boundary immediately after CR reaches this path. */
    if (pendingCarriageReturn) {
      lineHasher.update("\r");
      pendingCarriageReturn = false;
    }
    if (segment.endsWith("\r")) {
      lineHasher.update(segment.slice(0, -1));
      pendingCarriageReturn = true;
    } else {
      lineHasher.update(segment);
    }
  };
  const finishLine = (hasNewline: boolean): void => {
    if (pendingCarriageReturn) {
      if (hasNewline) {
        endings.crlf++;
      } else {
        lineHasher.update("\r");
      }
      pendingCarriageReturn = false;
    } else if (hasNewline) {
      endings.lf++;
    }
    if (selectedLine()) {
      selectedHashes.push(lineHasher.digest("base64url").slice(0, 5));
    } else {
      lineHasher.digest();
    }
    lineHasher = createHash("sha256");
  };

  const stream = createReadStream(path, { encoding: "utf8", signal });
  for await (const rawChunk of stream) {
    const chunk = String(rawChunk);
    revisionHasher.update(chunk);
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf("\n", start);
      if (newline < 0) {
        const segment = chunk.slice(start);
        hashSegment(segment);
        if (selectedLine()) {
          appendSelected(segment);
        }
        if (segment) {
          endsWithNewline = false;
        }
        break;
      }
      const segment = chunk.slice(start, newline);
      hashSegment(segment);
      if (selectedLine()) {
        appendSelected(segment);
        if (currentLine < selectionEnd) {
          appendSelected("\n");
        }
      }
      finishLine(true);
      totalLines++;
      currentLine++;
      endsWithNewline = true;
      start = newline + 1;
    }
  }
  finishLine(false);

  let content = selected;
  if (format === "hashed") {
    const selectedLines = selectedHashes.length === 0 ? [] : selected.split("\n");
    content = selectedLines
      .slice(0, selectedHashes.length)
      .map((line, index) => {
        const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
        // biome-ignore lint/style/noNonNullAssertion: selected lines are capped to available hashes.
        return `${offset + index}:${selectedHashes[index]!}|${normalized}`;
      })
      .join("\n");
  }
  const result = truncateHead(content, { maxBytes: DEFAULT_MAX_BYTES, maxLines: limit });
  const resultLineEnding = detectedLineEnding(endings.lf, endings.crlf);
  return {
    file: workspaceResultPath(cwd, path),
    format,
    content: result.content,
    revision: revisionHasher.digest("base64url").slice(0, 12),
    offset,
    lines: result.outputLines,
    totalLines,
    hasMore: selectionEnd < totalLines,
    truncated: result.truncated || selectionTruncated,
    lineEnding: resultLineEnding,
    endsWithNewline,
  };
}

function editWorkspace(cwd: string, args: unknown[], signal?: AbortSignal) {
  const path = resolveWorkspacePath(cwd, args[0]);
  return withFileMutationQueue(path, async () => {
    checkAbort(signal);
    const snapshot = await readSnapshot(path);
    const prepared = prepareEdit(snapshot.existed ? snapshot.contents : undefined, args[1]);
    checkAbort(signal);
    if (prepared.deleted) {
      await unlink(path);
      return {
        file: workspaceResultPath(cwd, path),
        revision: null,
        applied: prepared.applied,
        bytes: 0,
        deleted: true,
      };
    }
    await mkdir(dirname(path), { recursive: true });
    // biome-ignore lint/style/noNonNullAssertion: non-deleted edits always provide content.
    const next = prepared.next!;
    await writeFile(path, next, { encoding: "utf8", signal });
    return {
      file: workspaceResultPath(cwd, path),
      revision: fileRevision(next),
      applied: prepared.applied,
      bytes: Buffer.byteLength(next),
      deleted: false,
    };
  });
}

async function readSnapshot(path: string): Promise<{ existed: boolean; contents: string }> {
  try {
    return { existed: true, contents: await readFile(path, "utf8") };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { existed: false, contents: "" };
    }
    /* v8 ignore next -- filesystem errors other than missing paths propagate unchanged. */
    throw error;
  }
}

function withMutationQueues<T>(paths: string[], task: () => Promise<T>): Promise<T> {
  const [path, ...rest] = paths;
  return path === undefined
    ? task()
    : withFileMutationQueue(path, () => withMutationQueues(rest, task));
}

async function batchReads(
  cwd: string,
  operations: Array<{ operation: Record<string, unknown>; index: number }>,
  rawOptions: unknown,
  signal?: AbortSignal,
) {
  const options = rawOptions === undefined ? {} : object(rawOptions, "options");
  const failure = options.failure ?? "fail-fast";
  if (failure !== "fail-fast" && failure !== "settled") {
    throw new Error('options.failure must be "fail-fast" or "settled"');
  }
  const tasks = operations.map(async ({ operation, index }) => ({
    kind: "read" as const,
    index,
    ok: true as const,
    value: await readWorkspace(
      cwd,
      operation.options === undefined ? [operation.file] : [operation.file, operation.options],
      signal,
    ),
  }));
  if (failure === "fail-fast") {
    return { results: await Promise.all(tasks) };
  }
  return {
    results: await Promise.all(
      tasks.map((task, index) =>
        task.catch((error) => ({
          kind: "read" as const,
          index,
          ok: false as const,
          /* v8 ignore next -- workspace capability failures are normalized to Error instances. */
          error: (error instanceof Error ? error.message : String(error)).slice(0, 4000),
        })),
      ),
    ),
  };
}

function batchEdits(
  cwd: string,
  operations: Array<{ operation: Record<string, unknown>; index: number }>,
  signal?: AbortSignal,
) {
  const targets = operations.map(({ operation, index }) => ({
    path: resolveWorkspacePath(cwd, operation.file),
    changes: operation.changes,
    index,
  }));
  const paths = targets.map(({ path }) => path);
  if (new Set(paths).size !== paths.length) {
    throw new Error("edit batch operations must target unique files");
  }
  return withMutationQueues(
    [...paths].sort((a, b) => a.localeCompare(b)),
    async () => {
      const snapshots = new Map(
        await Promise.all(paths.map(async (path) => [path, await readSnapshot(path)] as const)),
      );
      const prepared = targets.map((target) => {
        // biome-ignore lint/style/noNonNullAssertion: every target has a snapshot.
        const snapshot = snapshots.get(target.path)!;
        return {
          ...target,
          snapshot,
          edit: prepareEdit(snapshot.existed ? snapshot.contents : undefined, target.changes),
        };
      });
      const committed: typeof prepared = [];
      try {
        for (const target of prepared) {
          checkAbort(signal);
          if (target.edit.deleted) {
            await unlink(target.path);
          } else {
            await mkdir(dirname(target.path), { recursive: true });
            // biome-ignore lint/style/noNonNullAssertion: non-deleted edits always provide content.
            await writeFile(target.path, target.edit.next!, { encoding: "utf8", signal });
          }
          committed.push(target);
        }
      } catch (error) {
        for (const target of committed.reverse()) {
          try {
            if (target.snapshot.existed) {
              await writeFile(target.path, target.snapshot.contents, "utf8");
            } else {
              await unlink(target.path);
            }
          } catch {
            // Preserve the original failure; rollback is best-effort.
          }
        }
        throw error;
      }
      return {
        files: prepared.map((target) => {
          // biome-ignore lint/style/noNonNullAssertion: deleted results do not read the revision.
          const next = target.edit.next!;
          return {
            file: workspaceResultPath(cwd, target.path),
            revision: target.edit.deleted ? null : fileRevision(next),
            applied: target.edit.applied,
            bytes: target.edit.deleted ? 0 : Buffer.byteLength(next),
            deleted: target.edit.deleted,
          };
        }),
      };
    },
  );
}

function batchWorkspace(cwd: string, args: unknown[], signal?: AbortSignal) {
  const rawOperations = args[0];
  if (!Array.isArray(rawOperations) || rawOperations.length === 0) {
    throw new Error("operations must be a non-empty array");
  }
  const parsed = rawOperations.map((raw, index) => {
    const operation = object(raw, `operations[${index}]`);
    const kind = string(operation.kind, `operations[${index}].kind`);
    if (kind !== "read" && kind !== "edit") {
      throw new Error(`Unknown batch operation: ${kind}`);
    }
    return { kind, operation, index };
  });
  const reads = parsed.every(({ kind }) => kind === "read");
  const edits = parsed.every(({ kind }) => kind === "edit");
  if (!(reads || edits)) {
    throw new Error("batch cannot mix read and edit operations");
  }
  if (reads) {
    return batchReads(cwd, parsed, args[1], signal);
  }
  if (args[1] !== undefined) {
    throw new Error("batch options are only supported for read operations");
  }
  return batchEdits(cwd, parsed, signal);
}

interface SearchContextLine {
  line: number;
  anchor: string;
  text: string;
}

interface SearchMatch extends SearchContextLine {
  file: string;
  revision: string;
  column: number;
  before: SearchContextLine[];
  after: SearchContextLine[];
}

async function searchWorkspace(cwd: string, args: unknown[], signal?: AbortSignal) {
  const query = string(args[0], "query");
  if (!query) {
    throw new Error("query must not be empty");
  }
  const options = args[1] === undefined ? {} : object(args[1], "options");
  const searchPath = options.path === undefined ? cwd : resolveWorkspacePath(cwd, options.path);
  const regex = options.regex === undefined ? false : Boolean(options.regex);
  const caseSensitive = options.caseSensitive === undefined ? true : Boolean(options.caseSensitive);
  const contextLines = Number(options.contextLines ?? 0);
  const limit = Number(options.limit ?? 100);
  if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > 10) {
    throw new Error("contextLines must be an integer between 0 and 10");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS) {
    throw new Error(`limit must be an integer between 1 and ${MAX_SEARCH_RESULTS}`);
  }

  if (regex) {
    try {
      RegExp(query, caseSensitive ? "g" : "gi");
    } catch (error) {
      throw new Error(`Invalid search regex: ${String(error)}`);
    }
  }

  const pathInfo = await stat(searchPath);
  let files: string[];
  if (pathInfo.isFile()) {
    files = [searchPath];
  } else if (pathInfo.isDirectory()) {
    const patterns =
      typeof options.glob === "string" || Array.isArray(options.glob)
        ? (options.glob as string | string[])
        : "**/*";
    const ignore = [
      "**/.git/**",
      "**/node_modules/**",
      ...(Array.isArray(options.ignore) ? options.ignore.map(String) : []),
    ];
    const discovered: string[] = [];
    const stream = fg.stream(patterns, {
      cwd: searchPath,
      dot: Boolean(options.dot),
      onlyFiles: true,
      ignore,
      followSymbolicLinks: false,
      absolute: true,
    });
    for await (const entry of stream) {
      discovered.push(String(entry));
      /* v8 ignore next -- the hard file cap is impractical to exercise in unit fixtures. */
      if (discovered.length === MAX_SEARCH_FILES) {
        break;
      }
    }
    files = discovered.sort((a, b) => a.localeCompare(b));
  } else {
    throw new Error("search path must be a file or directory");
  }

  const matches: SearchMatch[] = [];
  let filesSearched = 0;
  let filesSkipped = 0;
  let truncated = false;
  const regexMatcher = regex ? new InterruptibleRegexMatcher(query, caseSensitive) : undefined;
  try {
    for (const file of files) {
      checkAbort(signal);
      let buffer: Buffer;
      try {
        const info = await stat(file);
        if (info.size > MAX_SEARCH_FILE_BYTES) {
          filesSkipped++;
          continue;
        }
        buffer = await readFile(file, { signal });
      } catch {
        filesSkipped++;
        continue;
      }
      if (buffer.includes(0)) {
        filesSkipped++;
        continue;
      }
      filesSearched++;
      const contents = buffer.toString("utf8");
      const revision = fileRevision(contents);
      const filePath = workspaceResultPath(cwd, file);
      const lines = contents
        .split("\n")
        .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
      const contextLine = (lineIndex: number): SearchContextLine => {
        // biome-ignore lint/style/noNonNullAssertion: callers use indices bounded by lines.length.
        const text = lines[lineIndex]!;
        return { line: lineIndex + 1, anchor: lineAnchor(lineIndex + 1, text), text };
      };
      const regexMatches = regexMatcher
        ? await regexMatcher.match(lines, limit - matches.length)
        : [];
      const regexColumns = new Map<number, number[]>();
      for (const match of regexMatches) {
        const columns = regexColumns.get(match.lineIndex) ?? [];
        columns.push(match.column);
        regexColumns.set(match.lineIndex, columns);
      }
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        // biome-ignore lint/style/noNonNullAssertion: lineIndex is bounded by lines.length.
        const text = lines[lineIndex]!;
        const columns: number[] = regexColumns.get(lineIndex) ?? [];
        if (!regexMatcher) {
          const haystack = caseSensitive ? text : text.toLowerCase();
          const needle = caseSensitive ? query : query.toLowerCase();
          let offset = 0;
          while (
            offset <= haystack.length - needle.length &&
            columns.length < limit - matches.length
          ) {
            const found = haystack.indexOf(needle, offset);
            if (found < 0) {
              break;
            }
            columns.push(found);
            offset = found + Math.max(1, needle.length);
          }
        }
        for (const column of columns) {
          matches.push({
            file: filePath,
            revision,
            line: lineIndex + 1,
            anchor: lineAnchor(lineIndex + 1, text),
            column: column + 1,
            text,
            before: Array.from({ length: Math.min(contextLines, lineIndex) }, (_, index) =>
              contextLine(lineIndex - Math.min(contextLines, lineIndex) + index),
            ),
            after: Array.from(
              { length: Math.min(contextLines, lines.length - lineIndex - 1) },
              (_, index) => contextLine(lineIndex + index + 1),
            ),
          });
          if (matches.length >= limit) {
            truncated = true;
            break;
          }
        }
        if (truncated) {
          break;
        }
      }
      if (truncated) {
        break;
      }
    }
  } finally {
    await regexMatcher?.close();
  }
  return { matches, truncated, filesSearched, filesSkipped };
}

async function globWorkspace(cwd: string, args: unknown[], signal?: AbortSignal) {
  const patterns =
    typeof args[0] === "string" || Array.isArray(args[0]) ? (args[0] as string | string[]) : "**/*";
  const options = args[1] === undefined ? {} : object(args[1], "options");
  const limit = Number(options.limit ?? MAX_GLOB_RESULTS);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_GLOB_RESULTS) {
    throw new Error(`limit must be an integer between 1 and ${MAX_GLOB_RESULTS}`);
  }

  const entries: string[] = [];
  let truncated = false;
  const stream = fg.stream(patterns, {
    cwd,
    dot: Boolean(options.dot),
    onlyFiles: options.onlyFiles === undefined ? false : Boolean(options.onlyFiles),
    ignore: Array.isArray(options.ignore) ? options.ignore.map(String) : [],
    followSymbolicLinks: false,
  });
  for await (const entry of stream) {
    checkAbort(signal);
    if (entries.length === limit) {
      truncated = true;
      break;
    }
    entries.push(String(entry));
  }
  entries.sort((a, b) => a.localeCompare(b));
  return { entries, truncated };
}

export async function handleWorkspace(
  cwd: string,
  method: string,
  args: unknown[],
  signal?: AbortSignal,
): Promise<unknown> {
  checkAbort(signal);
  switch (method) {
    case "read":
      return readWorkspace(cwd, args, signal);
    case "edit":
      return editWorkspace(cwd, args, signal);
    case "batch":
      return batchWorkspace(cwd, args, signal);
    case "search":
      return searchWorkspace(cwd, args, signal);
    case "list": {
      const path = args[0] === undefined ? cwd : resolveWorkspacePath(cwd, args[0]);
      const entries = await readdir(path, { withFileTypes: true });
      return entries.slice(0, 2000).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
      }));
    }
    case "glob":
      return globWorkspace(cwd, args, signal);
    case "stat": {
      const info = await stat(resolveWorkspacePath(cwd, args[0]));
      return {
        size: info.size,
        modified: info.mtime.toISOString(),
        directory: info.isDirectory(),
        file: info.isFile(),
      };
    }
    /* v8 ignore next -- registry validation rejects unknown workspace methods before dispatch. */
    default:
      throw new Error(`Capability registry and workspace dispatcher disagree: ${method}`);
  }
}
