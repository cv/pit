import { constants } from "node:fs";
import { mkdir, opendir, open, lstat, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import { validateSavedFunctionSource } from "../core.js";
import { functionIdFromRelativePath, functionRelativePath } from "../identifier.js";
import type { PersistentFunctionMetadata } from "../source.js";

export interface PersistentFunctionCandidate {
  source: string;
  metadata: PersistentFunctionMetadata;
}

export interface PersistentFunctionCandidates {
  candidates: Map<string, PersistentFunctionCandidate>;
  discoveredNames: Set<string>;
  invalid: Map<string, string>;
  errors: string[];
}

export function isMissingFileError(error: unknown): boolean {
  return (error as { code?: string }).code === "ENOENT";
}

export async function assertPersistentPath(directory: string, id: string): Promise<void> {
  const segments = functionRelativePath(id).split(sep);
  let path = directory;
  for (let index = 0; index <= segments.length; index++) {
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error("function storage paths must not be symlinks");
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    if (index < segments.length) path = join(path, segments[index] as string);
  }
}

export async function writePersistentFunctionFile(path: string, source: string): Promise<void> {
  await withFileMutationQueue(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporary, source + (source.endsWith("\n") ? "" : "\n"), "utf8");
      await rename(temporary, path);
    } catch (error) {
      try {
        await rm(temporary, { force: true });
      } catch {
        // Preserve the original write failure when best-effort cleanup also fails.
      }
      throw error;
    }
  });
}

export function removePersistentFunctionFile(path: string): Promise<boolean> {
  return withFileMutationQueue(path, async () => {
    try {
      await rm(path);
      return true;
    } catch (error) {
      if (isMissingFileError(error)) return false;
      throw error;
    }
  });
}

const MAX_DISCOVERED_ENTRIES = 2048;
const MAX_DISCOVERED_BYTES = 4_000_000;
const MAX_FILE_BYTES = 100_000;

async function discoverFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  let entries = 0;
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("function storage root must be a real directory");
    }
    const stream = await opendir(path);
    for await (const entry of stream) {
      if (++entries > MAX_DISCOVERED_ENTRIES)
        throw new Error("function discovery exceeds entry limit");
      if (entry.name.startsWith(".")) continue;
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        // Never traverse symlinks. A .ts symlink is diagnosed as an invalid definition below.
        if (entry.name.endsWith(".ts")) files.push(child);
      } else if (entry.isDirectory()) {
        await visit(child);
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        files.push(child);
      }
    }
  };
  try {
    await lstat(directory);
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
  await visit(directory);
  return files.sort();
}

async function boundedSource(path: string): Promise<string> {
  if ((await lstat(path)).isSymbolicLink()) throw new Error("function files must not be symlinks");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_FILE_BYTES) throw new Error("saved function source exceeds 100 KB");
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    await file.close();
  }
}

export async function readPersistentFunctionCandidates(input: {
  directory: string;
  metadata(source: string): PersistentFunctionMetadata | undefined;
}): Promise<PersistentFunctionCandidates> {
  const candidates = new Map<string, PersistentFunctionCandidate>();
  const discoveredNames = new Set<string>();
  const invalid = new Map<string, string>();
  const errors: string[] = [];
  const portablePaths = new Map<string, string>();
  let bytes = 0;
  for (const path of await discoverFiles(input.directory)) {
    const relativePath = relative(input.directory, path);
    let id: string | undefined;
    try {
      id = relativePath.slice(0, -3).split(sep).join(".");
      id = functionIdFromRelativePath(relativePath);
      discoveredNames.add(id);
      const folded = id.toLowerCase();
      const previous = portablePaths.get(folded);
      if (previous && previous !== id) {
        const message = `case-insensitive function collision: ${previous} and ${id}`;
        invalid.set(previous, message);
        candidates.delete(previous);
        throw new Error(message);
      }
      portablePaths.set(folded, id);
      const source = await boundedSource(path);
      bytes += Buffer.byteLength(source);
      if (bytes > MAX_DISCOVERED_BYTES)
        throw new Error("function discovery exceeds source byte limit");
      const metadata = input.metadata(source);
      if (!metadata) throw new Error("expected one documented top-level function declaration");
      if (metadata.name !== id.split(".").at(-1)) {
        throw new Error(`filename must be ${metadata.name}.ts`);
      }
      validateSavedFunctionSource(source);
      candidates.set(id, {
        source,
        metadata: {
          ...metadata,
          name: id,
          signature: metadata.signature.replace(metadata.name, id),
        },
      });
    } catch (error) {
      const message = `${relativePath}: ${(error as Error).message}`;
      errors.push(message);
      if (id) invalid.set(id, message);
    }
    if (bytes > MAX_DISCOVERED_BYTES)
      throw new Error("function discovery exceeds source byte limit");
  }
  // Diagnose every ambiguous definition rather than choosing a filesystem-order winner.
  for (const id of discoveredNames) {
    const conflict = [...discoveredNames].some(
      (other) => other !== id && (id.startsWith(other + ".") || other.startsWith(id + ".")),
    );
    if (conflict) {
      const message = `${functionRelativePath(id)}: function namespace conflict`;
      invalid.set(id, message);
      errors.push(message);
    }
  }
  for (const id of invalid.keys()) candidates.delete(id);
  return { candidates, discoveredNames, invalid, errors };
}
