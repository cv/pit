import { validateTypeScript } from "../../sandbox/validation.js";
import { createLayeredFunctionRegistry } from "../definitions.js";
import { getFunctionDependencies } from "../dependencies.js";
import { functionIdSegments, functionRelativePath } from "../identifier.js";
import { resolveFunctionGraph, sourceFunctionDefinition } from "../resolved-graph.js";
import { getPersistentFunctionMetadata } from "../source.js";

export function validatePersistentFunction(
  id: string,
  source: string,
  sources: ReadonlyMap<string, string>,
): void {
  const name = functionIdSegments(id).at(-1);
  const metadata = getPersistentFunctionMetadata(source);
  if (!metadata || metadata.name !== name)
    throw new Error("persistent function declaration must match its canonical identifier");
  const paths = new Map<string, string>();
  for (const key of sources.keys()) {
    functionRelativePath(key);
    const previous = paths.get(key.toLowerCase());
    if (previous && previous !== key)
      throw new Error(`case-insensitive function collision: ${previous} and ${key}`);
    paths.set(key.toLowerCase(), key);
  }
  const registry = createLayeredFunctionRegistry(
    [...sources].map(([key, value]) => sourceFunctionDefinition(key, "user", value)),
  );
  resolveFunctionGraph(source, registry);
  validateTypeScript(source, sources);
}

/** Invalid persisted definitions reserve their identifiers until explicitly fixed or removed. */
export function assertFunctionsAvailable(
  source: string,
  sources: ReadonlyMap<string, string>,
  invalid: ReadonlyMap<string, string>,
): void {
  if (!invalid.size) return;
  const visiting = new Set<string>();
  const visit = (implementation: string): void => {
    for (const { id } of getFunctionDependencies(implementation).dependencies) {
      const error = invalid.get(id);
      if (error) throw new Error(`Function "${id}" is unavailable: ${error}`);
      if (visiting.has(id)) continue;
      visiting.add(id);
      const dependency = sources.get(id);
      if (dependency !== undefined) visit(dependency);
    }
  };
  visit(source);
}
