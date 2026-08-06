import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { validateTypeScript } from "../../sandbox/validation.js";
import {
  type FunctionRegistry,
  validateRegistryCapacity,
  validateSavedFunctionName,
} from "../core.js";
import { getSavedFunctionDependencyGraph } from "../graph.js";
import { getGlobalFunctionMetadata, type PersistentFunctionMetadataRegistry } from "../source.js";
import {
  isMissingFileError,
  readPersistentFunctionCandidates,
  removePersistentFunctionFile,
  writePersistentFunctionFile,
} from "./files.js";

const GLOBAL_FUNCTION_DIRECTORY = ["pit", "functions"] as const;

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

export async function loadGlobalFunctionConfig(): Promise<GlobalFunctionConfig> {
  let source: string;
  try {
    source = await readFile(globalFunctionConfigPath(), "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
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
  await writePersistentFunctionFile(path, source);
  registry.set(name, source);
  return replaced;
}

export function removeGlobalFunction(name: string): Promise<boolean> {
  return removePersistentFunctionFile(globalFunctionPath(name));
}

export async function loadGlobalFunctions(
  registry: FunctionRegistry,
  metadata: PersistentFunctionMetadataRegistry,
): Promise<string[]> {
  registry.clear();
  metadata.clear();
  const { candidates, errors } = await readPersistentFunctionCandidates({
    directory: globalFunctionDirectory(),
    marker: "global",
    metadata: getGlobalFunctionMetadata,
  });

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
