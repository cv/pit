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
import { type ConfiguredFunctionPaths, defaultProjectFunctionDirectory } from "./paths.js";
import { validatePersistentFunction, filterPersistentIdentifiers } from "./validation.js";

/** Settings from a trusted project's `.pi/pit.json`. Absent or invalid files yield the defaults. */
export interface PitProjectConfig {
  allowedTools?: string[];
  /** Directories for project and user functions, as written; see resolveFunctionPaths. */
  paths?: ConfiguredFunctionPaths;
  error?: string;
}

function projectFunctionPath(directory: string, name: string): string {
  return join(directory, functionRelativePath(name));
}

function configuredPaths(value: unknown): ConfiguredFunctionPaths | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("paths must be an object");
  const paths: ConfiguredFunctionPaths = {};
  for (const key of ["project", "user"] as const) {
    const path = value[key];
    if (path === undefined) continue;
    if (typeof path !== "string" || path.trim().length === 0) {
      throw new Error(`paths.${key} must be a non-empty string`);
    }
    paths[key] = path;
  }
  return paths;
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
    const paths = configuredPaths(config.paths);
    return {
      ...(allowedTools === undefined ? {} : { allowedTools }),
      ...(paths === undefined ? {} : { paths }),
    };
  } catch (error) {
    return { error: `Invalid ${CONFIG_DIR_NAME}/pit.json: ${(error as Error).message}` };
  }
}

export async function saveProjectFunction(
  directory: string,
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
  await assertPersistentPath(directory, name);
  await writePersistentFunctionFile(projectFunctionPath(directory, name), source);
  registry.set(name, source);
  return replaced;
}

export async function removeProjectFunction(directory: string, name: string): Promise<boolean> {
  await assertPersistentPath(directory, name);
  return removePersistentFunctionFile(projectFunctionPath(directory, name));
}

export async function loadProjectFunctions(
  ctx: ExtensionContext,
  registry: FunctionRegistry,
  metadata: PersistentFunctionMetadataRegistry,
  {
    user = new Map(),
    invalidDefinitions = new Map(),
    invalidUser = new Map(),
    directory = defaultProjectFunctionDirectory(ctx.cwd),
  }: {
    user?: ReadonlyMap<string, string>;
    invalidDefinitions?: Map<string, string>;
    invalidUser?: ReadonlyMap<string, string>;
    /** The resolved project-function directory; defaults to `.pi/functions`. */
    directory?: string;
  } = {},
): Promise<string[]> {
  registry.clear();
  metadata.clear();
  invalidDefinitions.clear();
  if (!ctx.isProjectTrusted()) {
    return [];
  }

  const { candidates, errors, invalid } = await readPersistentFunctionCandidates({
    directory,
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
