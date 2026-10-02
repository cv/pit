import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { isRecord } from "../../shared/records.js";
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

/** Settings from a trusted project's `.pi/pit.json`. Absent or invalid files yield the defaults. */
export interface PitProjectConfig {
  allowedTools?: string[];
  error?: string;
}

function projectFunctionDirectory(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "functions");
}

function projectFunctionPath(cwd: string, name: string): string {
  return join(projectFunctionDirectory(cwd), functionRelativePath(name));
}

export async function loadPitProjectConfig(ctx: ExtensionContext): Promise<PitProjectConfig> {
  if (!ctx.isProjectTrusted()) {
    return {};
  }
  let source: string;
  try {
    source = await readFile(join(ctx.cwd, CONFIG_DIR_NAME, "pit.json"), "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return {};
    }
    throw error;
  }
  try {
    const config = JSON.parse(source) as unknown;
    if (!isRecord(config)) {
      throw new Error("configuration must be a JSON object");
    }
    const allowedTools = config.allowedTools;
    if (
      allowedTools !== undefined &&
      (!Array.isArray(allowedTools) ||
        !allowedTools.every((name) => typeof name === "string" && name.trim().length > 0))
    ) {
      throw new Error("allowedTools must be an array of non-empty strings");
    }
    return allowedTools === undefined ? {} : { allowedTools };
  } catch (error) {
    return { error: `Invalid ${CONFIG_DIR_NAME}/pit.json: ${(error as Error).message}` };
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
  await writePersistentFunctionFile(projectFunctionPath(cwd, name), source);
  registry.set(name, source);
  return replaced;
}

export async function removeProjectFunction(cwd: string, name: string): Promise<boolean> {
  await assertPersistentPath(projectFunctionDirectory(cwd), name);
  return removePersistentFunctionFile(projectFunctionPath(cwd, name));
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
