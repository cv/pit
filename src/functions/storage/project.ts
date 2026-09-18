import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { type FunctionRegistry, validateSavedFunctionSource } from "../core.js";
import { functionRelativePath } from "../identifier.js";
import {
  getPersistentFunctionMetadata,
  type PersistentFunctionMetadataRegistry,
} from "../source.js";
import {
  isMissingFileError,
  assertPersistentPath,
  readPersistentFunctionCandidates,
  removePersistentFunctionFile,
  writePersistentFunctionFile,
} from "./files.js";
import { validatePersistentFunction, filterPersistentIdentifiers } from "./validation.js";

const PROJECT_FUNCTION_DIRECTORY = ["functions"] as const;

export interface ProjectFunctionConfig {
  enabled: boolean;
  error?: string;
}

export function projectFunctionDirectory(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, ...PROJECT_FUNCTION_DIRECTORY);
}

function configPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "pit.json");
}

function pathFor(directory: string, name: string): string {
  return join(directory, functionRelativePath(name));
}

function currentPathFor(cwd: string, name: string): string {
  return pathFor(projectFunctionDirectory(cwd), name);
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
    const enabledSection = (key: "projectFunctions"): boolean | undefined => {
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
    return {
      enabled: projectEnabled,
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
  storage: FunctionRegistry | { registry: FunctionRegistry; user: ReadonlyMap<string, string> },
): Promise<boolean> {
  const registry = storage instanceof Map ? storage : storage.registry;
  const user = storage instanceof Map ? new Map<string, string>() : storage.user;
  validateSavedFunctionSource(source);
  const candidates = new Map(registry);
  candidates.set(name, source);
  validatePersistentFunction(name, source, candidates, { layer: "project", userFunctions: user });
  const replaced = registry.has(name);
  await assertPersistentPath(projectFunctionDirectory(cwd), name);
  await writePersistentFunctionFile(currentPathFor(cwd, name), source);
  registry.set(name, source);
  return replaced;
}

export async function removeProjectFunction(cwd: string, name: string): Promise<boolean> {
  await assertPersistentPath(projectFunctionDirectory(cwd), name);
  return removePersistentFunctionFile(currentPathFor(cwd, name));
}

export async function loadProjectFunctions(
  ctx: ExtensionContext,
  registry: FunctionRegistry,
  metadata: PersistentFunctionMetadataRegistry,
  {
    user = new Map(),
    invalidDefinitions = new Map(),
    invalidUser = new Map(),
  }: {
    user?: ReadonlyMap<string, string>;
    invalidDefinitions?: Map<string, string>;
    invalidUser?: ReadonlyMap<string, string>;
  } = {},
): Promise<string[]> {
  registry.clear();
  metadata.clear();
  invalidDefinitions.clear();
  if (!ctx.isProjectTrusted()) {
    return [];
  }

  const { candidates, errors, invalid } = await readPersistentFunctionCandidates({
    directory: projectFunctionDirectory(ctx.cwd),
    metadata: getPersistentFunctionMetadata,
  });

  for (const [id, error] of invalid) invalidDefinitions.set(id, error);

  const sources = new Map([...candidates].map(([id, value]) => [id, value.source]));
  filterPersistentIdentifiers(sources, {
    layer: "project",
    userFunctions: user,
    invalidDefinitions,
    errors,
  });
  for (const [name, value] of candidates) {
    if (!sources.has(name)) continue;
    try {
      validatePersistentFunction(name, value.source, sources, {
        layer: "project",
        userFunctions: user,
        invalidDefinitions: new Map([...invalidUser, ...invalidDefinitions]),
        checkAll: false,
      });
      registry.set(name, value.source);
      metadata.set(name, value.metadata);
    } catch (error) {
      errors.push(`${name}.ts: ${(error as Error).message}`);
      invalidDefinitions.set(name, (error as Error).message);
    }
  }
  return errors;
}
