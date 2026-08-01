import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import fg from "fast-glob";
import { fileRevision, prepareEdit } from "./hashline.js";
import {
  checkAbort,
  object,
  resolveWorkspacePath,
  string,
  workspaceResultPath,
} from "./workspace-paths.js";
import { searchWorkspace } from "./workspace-search.js";

const MAX_GLOB_RESULTS = 10_000;

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
      if (!hasNewline) {
        lineHasher.update("\r");
      }
      pendingCarriageReturn = false;
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
  let returnedLines =
    result.content === "" ? (selectedHashes.length > 0 ? 1 : 0) : Math.max(1, result.outputLines);
  if (format === "raw" && result.content.endsWith("\n")) {
    returnedLines++;
  }
  const hasMore = selectionEnd < totalLines;
  const truncated = result.truncated || selectionTruncated;
  return {
    file: workspaceResultPath(cwd, path),
    format,
    content: result.content,
    revision: revisionHasher.digest("base64url").slice(0, 12),
    ...(offset === 1 ? {} : { offset }),
    lines: returnedLines,
    ...(totalLines === returnedLines ? {} : { totalLines }),
    ...(hasMore ? { hasMore: true as const } : {}),
    ...(truncated ? { truncated: true as const } : {}),
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
        results: prepared.map((target) => {
          // biome-ignore lint/style/noNonNullAssertion: deleted results do not read the revision.
          const next = target.edit.next!;
          return {
            kind: "edit" as const,
            index: target.index,
            ok: true as const,
            value: {
              file: workspaceResultPath(cwd, target.path),
              revision: target.edit.deleted ? null : fileRevision(next),
              applied: target.edit.applied,
              bytes: target.edit.deleted ? 0 : Buffer.byteLength(next),
              deleted: target.edit.deleted,
            },
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
