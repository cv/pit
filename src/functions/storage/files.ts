import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import { validateSavedFunctionName, validateSavedFunctionSource } from "../core.js";
import type { PersistentFunctionMetadata } from "../source.js";

export interface PersistentFunctionCandidate {
  source: string;
  metadata: PersistentFunctionMetadata;
}

export interface PersistentFunctionCandidates {
  candidates: Map<string, PersistentFunctionCandidate>;
  discoveredNames: Set<string>;
  errors: string[];
}

export function isMissingFileError(error: unknown): boolean {
  return (error as { code?: string }).code === "ENOENT";
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

export async function readPersistentFunctionCandidates(input: {
  directory: string;
  metadata(source: string): PersistentFunctionMetadata | undefined;
}): Promise<PersistentFunctionCandidates> {
  let entries;
  try {
    entries = await readdir(input.directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) {
      return { candidates: new Map(), discoveredNames: new Set(), errors: [] };
    }
    throw error;
  }

  const candidates = new Map<string, PersistentFunctionCandidate>();
  const discoveredNames = new Set<string>();
  const errors: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!(entry.isFile() && entry.name.endsWith(".ts"))) continue;
    discoveredNames.add(entry.name.slice(0, -3));
    try {
      const source = await readFile(join(input.directory, entry.name), "utf8");
      const metadata = input.metadata(source);
      if (!metadata) throw new Error("expected one documented top-level function declaration");
      validateSavedFunctionName(metadata.name);
      if (entry.name !== `${metadata.name}.ts`) {
        throw new Error(`filename must be ${metadata.name}.ts`);
      }
      validateSavedFunctionSource(source);
      candidates.set(metadata.name, { source, metadata });
    } catch (error) {
      errors.push(`${entry.name}: ${(error as Error).message}`);
    }
  }
  return { candidates, discoveredNames, errors };
}
