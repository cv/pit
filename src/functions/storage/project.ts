import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { validateTypeScript } from "../../sandbox/validation.js";
import {
  type FunctionRegistry,
  validateSavedFunctionName,
  validateSavedFunctionSource,
} from "../core.js";
import { getSavedFunctionDependencyGraph } from "../graph.js";
import { getProjectFunctionMetadata, type PersistentFunctionMetadataRegistry } from "../source.js";
import {
  isMissingFileError,
  readPersistentFunctionCandidates,
  removePersistentFunctionFile,
  writePersistentFunctionFile,
} from "./files.js";

const PROJECT_FUNCTION_DIRECTORY = ["pit", "functions"] as const;

export interface ProjectFunctionConfig {
  enabled: boolean;
  globalEnabled?: boolean;
  error?: string;
}

function directory(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, ...PROJECT_FUNCTION_DIRECTORY);
}

function configPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "pit.json");
}

function pathFor(cwd: string, name: string): string {
  validateSavedFunctionName(name);
  return join(directory(cwd), `${name}.ts`);
}

export async function loadProjectFunctionConfig(
  ctx: ExtensionContext,
): Promise<ProjectFunctionConfig> {
  if (!ctx.isProjectTrusted()) {
    return { enabled: false };
  }
  let source: string;
  try {
    source = await readFile(configPath(ctx.cwd), "utf8");
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
    const values = config as Record<string, unknown>;
    const enabledSection = (key: "globalFunctions" | "projectFunctions"): boolean | undefined => {
      const section = values[key];
      if (section === undefined) {
        return;
      }
      if (!(section && typeof section === "object" && !Array.isArray(section))) {
        throw new Error(`${key} must be an object`);
      }
      const enabled = (section as Record<string, unknown>).enabled;
      if (enabled === undefined) {
        return;
      }
      if (typeof enabled !== "boolean") {
        throw new Error(`${key}.enabled must be a boolean`);
      }
      return enabled;
    };
    const projectEnabled = enabledSection("projectFunctions") ?? false;
    const globalEnabled = enabledSection("globalFunctions");
    return {
      enabled: projectEnabled,
      ...(globalEnabled === undefined ? {} : { globalEnabled }),
    };
  } catch (error) {
    return {
      enabled: false,
      error: `Invalid ${CONFIG_DIR_NAME}/pit.json: ${(error as Error).message}`,
    };
  }
}

export async function saveProjectFunction(
  cwd: string,
  name: string,
  source: string,
  storage: FunctionRegistry | { registry: FunctionRegistry; global: ReadonlyMap<string, string> },
): Promise<boolean> {
  const registry = storage instanceof Map ? storage : storage.registry;
  const global = storage instanceof Map ? new Map<string, string>() : storage.global;
  validateSavedFunctionSource(source);
  const candidates = new Map(registry);
  candidates.set(name, source);
  validateTypeScript(source, new Map([...global, ...candidates]));
  const replaced = registry.has(name);
  const path = pathFor(cwd, name);
  await writePersistentFunctionFile(path, source);
  registry.set(name, source);
  return replaced;
}

export function removeProjectFunction(cwd: string, name: string): Promise<boolean> {
  return removePersistentFunctionFile(pathFor(cwd, name));
}

export async function loadProjectFunctions(
  ctx: ExtensionContext,
  registry: FunctionRegistry,
  metadata: PersistentFunctionMetadataRegistry,
  global: ReadonlyMap<string, string> = new Map(),
): Promise<string[]> {
  registry.clear();
  metadata.clear();
  if (!ctx.isProjectTrusted()) {
    return [];
  }

  const { candidates, errors } = await readPersistentFunctionCandidates({
    directory: directory(ctx.cwd),
    marker: "project",
    metadata: getProjectFunctionMetadata,
  });

  const sources = new Map([
    ...global,
    ...[...candidates].map(([name, value]) => [name, value.source] as const),
  ]);
  const sourceGraph = getSavedFunctionDependencyGraph(sources);
  for (const [name, value] of candidates) {
    try {
      const dependencies = new Map(
        sourceGraph.resolve(value.source).map((reference) => [reference.name, reference.source]),
      );
      dependencies.set(name, value.source);
      validateTypeScript(value.source, dependencies);
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
        validateTypeScript(source, new Map([...global, ...registry]));
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
