import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

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
import {
  assertFunctionsAvailable,
  validatePersistentFunction,
  filterPersistentIdentifiers,
} from "./validation.js";

export function userFunctionDirectory(): string {
  return join(getAgentDir(), "functions");
}

export function userFunctionPath(name: string): string {
  return join(userFunctionDirectory(), functionRelativePath(name));
}

export async function saveUserFunction(
  name: string,
  source: string,
  registry: FunctionRegistry,
): Promise<boolean> {
  validateRegistryCapacity(registry, name, source);
  const candidates = new Map(registry);
  candidates.set(name, source);
  validatePersistentFunction(name, source, candidates);
  const replaced = registry.has(name);
  const path = userFunctionPath(name);
  await assertPersistentPath(userFunctionDirectory(), name);
  await writePersistentFunctionFile(path, source);
  registry.set(name, source);
  return replaced;
}

export async function removeUserFunction(name: string): Promise<boolean> {
  await assertPersistentPath(userFunctionDirectory(), name);
  return removePersistentFunctionFile(userFunctionPath(name));
}

export async function loadUserFunctions(
  registry: FunctionRegistry,
  metadata: PersistentFunctionMetadataRegistry,
  invalidDefinitions: Map<string, string> = new Map(),
): Promise<string[]> {
  registry.clear();
  metadata.clear();
  invalidDefinitions.clear();
  const { candidates, errors, invalid } = await readPersistentFunctionCandidates({
    directory: userFunctionDirectory(),
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
