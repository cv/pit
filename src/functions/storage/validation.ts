import { validateTypeScript } from "../../sandbox/validation.js";
import { isSealedGlobalFunction } from "../definitions.js";
import { getFunctionDependencies } from "../dependencies.js";
import { functionRegistry } from "../environment.js";
import { functionIdSegments, functionRelativePath } from "../identifier.js";
import { getPersistentFunctionMetadata } from "../source.js";

export function validatePersistentFunction(
  id: string,
  source: string,
  sources: ReadonlyMap<string, string>,
  options: {
    layer?: "user" | "project";
    userFunctions?: ReadonlyMap<string, string>;
    invalidDefinitions?: ReadonlyMap<string, string>;
    checkAll?: boolean;
  } = {},
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
  const layer = options.layer ?? "user";
  validateTypeScript(source, sources, undefined, {
    environment: {
      ...(layer === "user"
        ? { userFunctions: sources }
        : { userFunctions: options.userFunctions ?? new Map(), projectFunctions: sources }),
      ...(options.invalidDefinitions ? { invalidDefinitions: options.invalidDefinitions } : {}),
    },
    definition: { id, layer },
    checkAll: options.checkAll ?? true,
  });
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
      if (error && !isSealedGlobalFunction(id))
        throw new Error(`Function "${id}" is unavailable: ${error}`);
      if (visiting.has(id)) continue;
      visiting.add(id);
      const dependency = sources.get(id);
      if (dependency !== undefined) visit(dependency);
    }
  };
  visit(source);
}

export function filterPersistentIdentifiers(
  sources: Map<string, string>,
  options: {
    layer: "user" | "project";
    userFunctions?: ReadonlyMap<string, string>;
    invalidDefinitions: Map<string, string>;
    errors: string[];
  },
): void {
  const registry = functionRegistry(
    options.layer === "project" ? { userFunctions: options.userFunctions ?? new Map() } : {},
  );
  for (const [id, source] of sources) {
    try {
      registry.set({ id, source, kind: "source", layer: options.layer });
    } catch (error) {
      const message = (error as Error).message;
      sources.delete(id);
      options.invalidDefinitions.set(id, message);
      options.errors.push(`${functionRelativePath(id)}: ${message}`);
    }
  }
}
