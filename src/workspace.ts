import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { applyPatch as applyUnifiedPatch, parsePatch, type StructuredPatch } from "diff";
import fg from "fast-glob";
import { CAPABILITY_METHODS } from "./capability-registry.js";
import { InterruptibleRegexMatcher } from "./regex-worker.js";

const MAX_PATCH_BYTES = 1_000_000;
const MAX_SEARCH_FILE_BYTES = 1_000_000;
const MAX_SEARCH_FILES = 2000;
const MAX_SEARCH_RESULTS = 500;
const MAX_GLOB_RESULTS = 10_000;
const AT_PATH_PREFIX = /^@/;
const DIFF_PATH_PREFIX = /^(?:a|b)\//;
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

async function readText(cwd: string, args: unknown[], signal?: AbortSignal) {
  const path = resolveWorkspacePath(cwd, args[0]);
  const options = args[1] === undefined ? {} : object(args[1], "options");
  const offset = Number(options.offset ?? 1);
  const limit = Number(options.limit ?? DEFAULT_MAX_LINES);
  if (!Number.isInteger(offset) || offset < 1 || !Number.isInteger(limit) || limit < 1) {
    throw new Error("offset and limit must be positive integers");
  }

  const selectionEnd = offset + limit - 1;
  const maxCaptureCharacters = DEFAULT_MAX_BYTES + 1;
  let selected = "";
  let selectionTruncated = false;
  let currentLine = 1;
  let totalLines = 1;
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

  const stream = createReadStream(path, { encoding: "utf8", signal });
  for await (const rawChunk of stream) {
    const chunk = String(rawChunk);
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf("\n", start);
      if (newline < 0) {
        if (currentLine >= offset && currentLine <= selectionEnd) {
          appendSelected(chunk.slice(start));
        }
        break;
      }
      if (currentLine >= offset && currentLine <= selectionEnd) {
        appendSelected(chunk.slice(start, newline));
        if (currentLine < selectionEnd) {
          appendSelected("\n");
        }
      }
      totalLines++;
      currentLine++;
      start = newline + 1;
    }
  }

  const result = truncateHead(selected, { maxBytes: DEFAULT_MAX_BYTES, maxLines: limit });
  return {
    text: result.content,
    truncated: result.truncated || selectionTruncated,
    offset,
    lines: result.outputLines,
    totalLines,
  };
}

function sourceLocation(contents: string, index: number): string {
  const before = contents.slice(0, index);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  const column = index - lastNewline;
  return `${line}:${column}`;
}

function occurrenceLocations(contents: string, search: string): number[] {
  const locations: number[] = [];
  let offset = 0;
  while (offset <= contents.length - search.length) {
    const found = contents.indexOf(search, offset);
    if (found < 0) {
      break;
    }
    locations.push(found);
    offset = found + 1;
  }
  return locations;
}

function applyTextEdits(current: string, rawEdits: unknown): { next: string; edits: number } {
  if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
    throw new Error("edits must be a non-empty array");
  }
  const replacements = rawEdits.map((raw: unknown, index: number) => {
    const edit = object(raw, `edits[${index}]`);
    const oldText = string(edit.oldText, `edits[${index}].oldText`);
    const newText = string(edit.newText, `edits[${index}].newText`);
    if (!oldText) {
      throw new Error(`edits[${index}].oldText may not be empty`);
    }
    const occurrences = occurrenceLocations(current, oldText);
    if (occurrences.length === 0) {
      throw new Error(`edits[${index}].oldText was not found`);
    }
    if (occurrences.length > 1) {
      const shown = occurrences.slice(0, 10).map((offset) => sourceLocation(current, offset));
      const omitted = occurrences.length - shown.length;
      throw new Error(
        `edits[${index}].oldText is not unique; matched ${occurrences.length} times at ${shown.join(", ")}` +
          (omitted ? ` (and ${omitted} more)` : ""),
      );
    }
    // biome-ignore lint/style/noNonNullAssertion: the zero-occurrence case returned above.
    const start = occurrences[0]!;
    return { start, end: start + oldText.length, newText };
  });
  const ordered = [...replacements].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: loop bounds guarantee both entries.
    if (ordered[i]!.start < ordered[i - 1]!.end) {
      throw new Error("edits overlap");
    }
  }
  let next = current;
  for (const replacement of ordered.reverse()) {
    next = next.slice(0, replacement.start) + replacement.newText + next.slice(replacement.end);
  }
  return { next, edits: replacements.length };
}

function editText(cwd: string, args: unknown[], signal?: AbortSignal) {
  const path = resolveWorkspacePath(cwd, args[0]);
  return withFileMutationQueue(path, async () => {
    checkAbort(signal);
    const current = await readFile(path, "utf8");
    const result = applyTextEdits(current, args[1]);
    checkAbort(signal);
    await writeFile(path, result.next, { encoding: "utf8", signal });
    return { path: workspaceResultPath(cwd, path), edits: result.edits };
  });
}

function withMutationQueues<T>(paths: string[], task: () => Promise<T>): Promise<T> {
  const [path, ...rest] = paths;
  return path === undefined
    ? task()
    : withFileMutationQueue(path, () => withMutationQueues(rest, task));
}

async function readSnapshot(path: string): Promise<{ existed: boolean; contents: string }> {
  try {
    return { existed: true, contents: await readFile(path, "utf8") };
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return { existed: false, contents: "" };
    }
    throw error;
  }
}

const READ_BATCH_KINDS = new Set(["readText", "stat", "list", "glob", "search"]);
const MUTATION_BATCH_KINDS = new Set(["write", "edit"]);

function readBatchArguments(kind: string, operation: Record<string, unknown>): unknown[] {
  switch (kind) {
    case "readText":
      return operation.options === undefined
        ? [operation.path]
        : [operation.path, operation.options];
    case "stat":
      return [operation.path];
    case "list":
      return operation.path === undefined ? [] : [operation.path];
    case "glob":
      return operation.options === undefined
        ? [operation.patterns]
        : [operation.patterns, operation.options];
    case "search":
      return operation.options === undefined
        ? [operation.query]
        : [operation.query, operation.options];
    /* v8 ignore next -- batch kind validation rejects unknown read operations before dispatch. */
    default:
      throw new Error(`Batch read dispatcher disagrees with validated kind: ${kind}`);
  }
}

async function batchReadWorkspace(
  cwd: string,
  operations: Array<{ kind: string; operation: Record<string, unknown>; index: number }>,
  rawOptions: unknown,
  signal?: AbortSignal,
) {
  const options = rawOptions === undefined ? {} : object(rawOptions, "options");
  const failure = options.failure ?? "fail-fast";
  if (failure !== "fail-fast" && failure !== "settled") {
    throw new Error('options.failure must be "fail-fast" or "settled"');
  }
  const execute = async ({ kind, operation, index }: (typeof operations)[number]) => ({
    kind,
    index,
    ok: true as const,
    value: await handleWorkspace(cwd, kind, readBatchArguments(kind, operation), signal),
  });
  const tasks = operations.map(execute);
  if (failure === "fail-fast") {
    return { results: await Promise.all(tasks) };
  }
  return {
    results: await Promise.all(
      tasks.map((task, index) =>
        task.catch((error) => ({
          // biome-ignore lint/style/noNonNullAssertion: every task has a matching operation index.
          kind: operations[index]!.kind,
          index,
          ok: false as const,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 4000),
        })),
      ),
    ),
  };
}

function batchWorkspace(cwd: string, args: unknown[], signal?: AbortSignal) {
  const rawOperations = args[0];
  if (!Array.isArray(rawOperations) || rawOperations.length === 0) {
    throw new Error("operations must be a non-empty array");
  }
  const parsed = rawOperations.map((raw, index) => {
    const operation = object(raw, `operations[${index}]`);
    const kind = string(operation.kind, `operations[${index}].kind`);
    if (!(READ_BATCH_KINDS.has(kind) || MUTATION_BATCH_KINDS.has(kind))) {
      throw new Error(`Unknown batch operation: ${kind}`);
    }
    return { kind, operation, index };
  });
  const readOnly = parsed.every(({ kind }) => READ_BATCH_KINDS.has(kind));
  const mutationOnly = parsed.every(({ kind }) => MUTATION_BATCH_KINDS.has(kind));
  if (!(readOnly || mutationOnly)) {
    throw new Error("batch cannot mix read-only and mutation operations");
  }
  if (readOnly) {
    return batchReadWorkspace(cwd, parsed, args[1], signal);
  }
  if (args[1] !== undefined) {
    throw new Error("batch options are only supported for read-only operations");
  }
  const operations = parsed.map(({ kind, operation, index }) => ({
    kind: kind as "write" | "edit",
    path: resolveWorkspacePath(cwd, operation.path),
    operation,
    index,
  }));
  const paths = operations.map((operation) => operation.path);
  if (new Set(paths).size !== paths.length) {
    throw new Error("batch operations must target unique paths");
  }

  return withMutationQueues([...paths].sort(), async () => {
    const snapshots = new Map(
      await Promise.all(paths.map(async (path) => [path, await readSnapshot(path)] as const)),
    );
    const prepared = operations.map(({ kind, path, operation, index }) => {
      // biome-ignore lint/style/noNonNullAssertion: snapshots are created for every operation path.
      const snapshot = snapshots.get(path)!;
      if (kind === "write") {
        const contents = string(operation.contents, `operations[${index}].contents`);
        return { kind, path, snapshot, next: contents, edits: undefined };
      }
      if (!snapshot.existed) {
        throw new Error(`operations[${index}] cannot edit a missing file`);
      }
      const result = applyTextEdits(snapshot.contents, operation.edits);
      return { kind, path, snapshot, next: result.next, edits: result.edits };
    });

    const committed: typeof prepared = [];
    try {
      for (const operation of prepared) {
        checkAbort(signal);
        await mkdir(dirname(operation.path), { recursive: true });
        await writeFile(operation.path, operation.next, { encoding: "utf8", signal });
        committed.push(operation);
      }
    } catch (error) {
      for (const operation of committed.reverse()) {
        try {
          if (operation.snapshot.existed) {
            await writeFile(operation.path, operation.snapshot.contents, "utf8");
          } else {
            await unlink(operation.path);
          }
        } catch {
          // Preserve the original write failure; rollback is best-effort.
        }
      }
      throw error;
    }
    return {
      files: prepared.map((operation) => ({
        path: workspaceResultPath(cwd, operation.path),
        kind: operation.kind,
        bytes: Buffer.byteLength(operation.next),
        ...(operation.edits === undefined ? {} : { edits: operation.edits }),
      })),
    };
  });
}

function normalizedPatchPath(fileName: string | undefined): string | undefined {
  if (!fileName || fileName === "/dev/null") {
    return;
  }
  return fileName.replace(DIFF_PATH_PREFIX, "");
}

function patchTarget(cwd: string, patch: StructuredPatch, index: number) {
  if (patch.isBinary) {
    throw new Error(`patch[${index}] is binary and cannot be applied`);
  }
  if (patch.isRename || patch.isCopy) {
    throw new Error(`patch[${index}] renames and copies are not supported`);
  }
  if (patch.hunks.length === 0) {
    throw new Error(`patch[${index}] has no hunks`);
  }
  const oldName = normalizedPatchPath(patch.oldFileName);
  const newName = normalizedPatchPath(patch.newFileName);
  const kind =
    patch.isCreate || oldName === undefined
      ? "create"
      : patch.isDelete || newName === undefined
        ? "delete"
        : "modify";
  if (kind === "modify" && oldName !== newName) {
    throw new Error(`patch[${index}] changes paths; renames are not supported`);
  }
  const name = kind === "delete" ? oldName : newName;
  if (!name) {
    throw new Error(`patch[${index}] does not identify a target file`);
  }
  return { patch, kind, path: resolveWorkspacePath(cwd, name), index };
}

function applyWorkspacePatch(cwd: string, args: unknown[], signal?: AbortSignal) {
  const patchText = string(args[0], "patch");
  if (!patchText.trim()) {
    throw new Error("patch must not be empty");
  }
  if (Buffer.byteLength(patchText) > MAX_PATCH_BYTES) {
    throw new Error(`patch exceeds ${formatSize(MAX_PATCH_BYTES)}`);
  }
  let parsed: StructuredPatch[];
  try {
    parsed = parsePatch(patchText);
  } catch (error) {
    throw new Error(`Invalid unified patch: ${String(error)}`);
  }
  const targets = parsed.map((patch, index) => patchTarget(cwd, patch, index));
  const paths = targets.map((target) => target.path);
  if (new Set(paths).size !== paths.length) {
    throw new Error("patch must contain at most one diff per file");
  }

  return withMutationQueues([...paths].sort(), async () => {
    const snapshots = new Map(
      await Promise.all(paths.map(async (path) => [path, await readSnapshot(path)] as const)),
    );
    const prepared = targets.map((target) => {
      // biome-ignore lint/style/noNonNullAssertion: snapshots are created for every patch target.
      const snapshot = snapshots.get(target.path)!;
      if (target.kind === "create" && snapshot.existed) {
        throw new Error(`patch[${target.index}] cannot create an existing file: ${target.path}`);
      }
      if (target.kind !== "create" && !snapshot.existed) {
        throw new Error(
          `patch[${target.index}] cannot ${target.kind} a missing file: ${target.path}`,
        );
      }
      const next = applyUnifiedPatch(snapshot.contents, target.patch, { fuzzFactor: 0 });
      if (next === false) {
        const hunkLines = target.patch.hunks
          .map((hunk) => `-${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines}`)
          .join(", ");
        throw new Error(
          `patch[${target.index}] failed to apply to ${target.path}; rejected hunks: ${hunkLines}`,
        );
      }
      return { ...target, snapshot, next };
    });

    const committed: typeof prepared = [];
    try {
      for (const target of prepared) {
        checkAbort(signal);
        if (target.kind === "delete") {
          await unlink(target.path);
        } else {
          await mkdir(dirname(target.path), { recursive: true });
          await writeFile(target.path, target.next, { encoding: "utf8", signal });
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
          // Preserve the original write failure; rollback is best-effort.
        }
      }
      throw error;
    }
    return {
      files: prepared.map((target) => ({
        path: workspaceResultPath(cwd, target.path),
        kind: target.kind,
        hunks: target.patch.hunks.length,
        bytes: target.kind === "delete" ? 0 : Buffer.byteLength(target.next),
      })),
    };
  });
}

interface SearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
  before: string[];
  after: string[];
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
      const lines = buffer.toString("utf8").split("\n");
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
            path: relative(cwd, file).replaceAll("\\", "/"),
            line: lineIndex + 1,
            column: column + 1,
            text,
            before: lines.slice(Math.max(0, lineIndex - contextLines), lineIndex),
            after: lines.slice(lineIndex + 1, lineIndex + 1 + contextLines),
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
    case "readText":
      return readText(cwd, args, signal);
    case "writeText": {
      const path = resolveWorkspacePath(cwd, args[0]);
      const contents = string(args[1], "contents");
      return withFileMutationQueue(path, async () => {
        checkAbort(signal);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, contents, { encoding: "utf8", signal });
        return { path: workspaceResultPath(cwd, path), bytes: Buffer.byteLength(contents) };
      });
    }
    case "editText":
      return editText(cwd, args, signal);
    case "batch":
      return batchWorkspace(cwd, args, signal);
    case "applyPatch":
      return applyWorkspacePatch(cwd, args, signal);
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
