import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import {
  getGlobalFunctionMetadata,
  getSavedFunctionDependencyGraph,
  type ProjectFunctionMetadata,
  validateTypeScript,
} from "./sandbox.js";
import {
  type FunctionRegistry,
  validateSavedFunctionName,
  validateRegistryCapacity,
  validateSavedFunctionSource,
} from "./saved-functions.js";

const GLOBAL_FUNCTION_DIRECTORY = ["pit", "functions"] as const;

export type GlobalFunctionMetadataRegistry = Map<string, ProjectFunctionMetadata>;

export interface GlobalFunctionConfig {
  enabled: boolean;
  error?: string;
}

export function globalFunctionDirectory(): string {
  return join(getAgentDir(), ...GLOBAL_FUNCTION_DIRECTORY);
}

export function globalFunctionConfigPath(): string {
  return join(getAgentDir(), "pit.json");
}

export function globalFunctionPath(name: string): string {
  validateSavedFunctionName(name);
  return join(globalFunctionDirectory(), `${name}.ts`);
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

export async function loadGlobalFunctionConfig(): Promise<GlobalFunctionConfig> {
  let source: string;
  try {
    source = await readFile(globalFunctionConfigPath(), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { enabled: false };
    }
    throw error;
  }
  try {
    const config = JSON.parse(source) as unknown;
    if (!(config && typeof config === "object" && !Array.isArray(config))) {
      throw new Error("configuration must be a JSON object");
    }
    const globalFunctions = (config as Record<string, unknown>).globalFunctions;
    if (globalFunctions === undefined) {
      return { enabled: false };
    }
    if (
      !(globalFunctions && typeof globalFunctions === "object" && !Array.isArray(globalFunctions))
    ) {
      throw new Error("globalFunctions must be an object");
    }
    const enabled = (globalFunctions as Record<string, unknown>).enabled;
    if (enabled === undefined) {
      return { enabled: false };
    }
    if (typeof enabled !== "boolean") {
      throw new Error("globalFunctions.enabled must be a boolean");
    }
    return { enabled };
  } catch (error) {
    return {
      enabled: false,
      error: `Invalid ${globalFunctionConfigPath()}: ${(error as Error).message}`,
    };
  }
}

export async function saveGlobalFunction(
  name: string,
  source: string,
  registry: FunctionRegistry,
): Promise<boolean> {
  validateRegistryCapacity(registry, name, source);
  const candidates = new Map(registry);
  candidates.set(name, source);
  validateTypeScript(source, candidates);
  const replaced = registry.has(name);
  const path = globalFunctionPath(name);
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
  registry.set(name, source);
  return replaced;
}

export function removeGlobalFunction(name: string): Promise<boolean> {
  const path = globalFunctionPath(name);
  return withFileMutationQueue(path, async () => {
    try {
      await rm(path);
      return true;
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return false;
      }
      throw error;
    }
  });
}

export async function loadGlobalFunctions(
  registry: FunctionRegistry,
  metadata: GlobalFunctionMetadataRegistry,
): Promise<string[]> {
  registry.clear();
  metadata.clear();
  let entries: Dirent[];
  try {
    entries = await readdir(globalFunctionDirectory(), { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return [];
    }
    throw error;
  }

  const errors: string[] = [];
  const candidates = new Map<string, { source: string; metadata: ProjectFunctionMetadata }>();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!(entry.isFile() && entry.name.endsWith(".ts"))) {
      continue;
    }
    try {
      const source = await readFile(join(globalFunctionDirectory(), entry.name), "utf8");
      const parsed = getGlobalFunctionMetadata(source);
      if (!parsed) {
        throw new Error("missing @pit global JSDoc marker");
      }
      validateSavedFunctionName(parsed.name);
      if (entry.name !== `${parsed.name}.ts`) {
        throw new Error(`filename must be ${parsed.name}.ts`);
      }
      validateSavedFunctionSource(source);
      candidates.set(parsed.name, { source, metadata: parsed });
    } catch (error) {
      errors.push(`${entry.name}: ${(error as Error).message}`);
    }
  }

  const sources = new Map([...candidates].map(([name, value]) => [name, value.source]));
  const graph = getSavedFunctionDependencyGraph(sources);
  for (const [name, value] of candidates) {
    try {
      const dependencies = new Map(
        graph.resolve(value.source).map((reference) => [reference.name, reference.source]),
      );
      dependencies.set(name, value.source);
      validateTypeScript(value.source, dependencies);
      validateRegistryCapacity(registry, name, value.source);
      registry.set(name, value.source);
      metadata.set(name, value.metadata);
    } catch (error) {
      errors.push(`${name}.ts: ${(error as Error).message}`);
    }
  }
  let removedInvalidDependency = true;
  while (removedInvalidDependency) {
    removedInvalidDependency = false;
    for (const [name, source] of registry) {
      try {
        validateTypeScript(source, registry);
      } catch (error) {
        registry.delete(name);
        metadata.delete(name);
        errors.push(`${name}.ts: ${(error as Error).message}`);
        removedInvalidDependency = true;
      }
    }
  }
  return errors;
}
