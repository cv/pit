import { join } from "node:path";

import { type FunctionRegistry, validateRegistryCapacity } from "../core.js";
import { functionRelativePath } from "../identifier.js";
import {
  getPersistentFunctionMetadata,
  type PersistentFunctionMetadataRegistry,
} from "../source.js";
import {
  assertPersistentPath,
  readPersistentFunctionCandidates,
  removePersistentFunctionFile,
  writePersistentFunctionFile,
} from "./files.js";
import { defaultUserFunctionDirectory } from "./paths.js";
import {
  assertFunctionsAvailable,
  validatePersistentFunction,
  filterPersistentIdentifiers,
} from "./validation.js";

/**
 * The user-function directory for a session: `paths.user` from the project's `.pi/pit.json`,
 * or Pi's default. Callers pass the session's resolved directory; omitting it uses the default.
 */
export function userFunctionDirectory(directory?: string): string {
  return directory || defaultUserFunctionDirectory();
}

export function userFunctionPath(name: string, directory?: string): string {
  return join(userFunctionDirectory(directory), functionRelativePath(name));
}

export async function saveUserFunction(
  name: string,
  source: string,
  registry: FunctionRegistry,
  directory?: string,
): Promise<boolean> {
  validateRegistryCapacity(registry, name, source);
  const candidates = new Map(registry);
  candidates.set(name, source);
  validatePersistentFunction(name, source, candidates);
  const replaced = registry.has(name);
  const path = userFunctionPath(name, directory);
  await assertPersistentPath(userFunctionDirectory(directory), name);
  await writePersistentFunctionFile(path, source);
  registry.set(name, source);
  return replaced;
}

export async function removeUserFunction(name: string, directory?: string): Promise<boolean> {
  await assertPersistentPath(userFunctionDirectory(directory), name);
  return removePersistentFunctionFile(userFunctionPath(name, directory));
}

export async function loadUserFunctions(
  registry: FunctionRegistry,
  metadata: PersistentFunctionMetadataRegistry,
  invalidDefinitions: Map<string, string> = new Map(),
  directory?: string,
): Promise<string[]> {
  registry.clear();
  metadata.clear();
  invalidDefinitions.clear();
  const { candidates, errors, invalid } = await readPersistentFunctionCandidates({
    directory: userFunctionDirectory(directory),
    metadata: getPersistentFunctionMetadata,
  });

  for (const [id, error] of invalid) invalidDefinitions.set(id, error);

  const sources = new Map([...candidates].map(([name, value]) => [name, value.source]));
  filterPersistentIdentifiers(sources, { layer: "user", invalidDefinitions, errors });
  for (const [name, value] of candidates) {
    if (!sources.has(name)) continue;
    try {
      validatePersistentFunction(name, value.source, sources, {
        invalidDefinitions,
        checkAll: false,
      });
      validateRegistryCapacity(registry, name, value.source);
      registry.set(name, value.source);
      metadata.set(name, value.metadata);
    } catch (error) {
      errors.push(`${name}.ts: ${(error as Error).message}`);
      invalidDefinitions.set(name, (error as Error).message);
    }
  }
  let removedInvalidDependency = true;
  while (removedInvalidDependency) {
    removedInvalidDependency = false;
    for (const [name, source] of registry) {
      try {
        assertFunctionsAvailable(source, registry, invalidDefinitions);
      } catch (error) {
        registry.delete(name);
        metadata.delete(name);
        errors.push(`${name}.ts: ${(error as Error).message}`);
        invalidDefinitions.set(name, (error as Error).message);
        removedInvalidDependency = true;
      }
    }
  }
  return errors;
}
