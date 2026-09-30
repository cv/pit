import { createLayeredFunctionRegistry, type FunctionDefinition } from "./definitions.js";
import { getFunctionDependencies } from "./dependencies.js";
import type { FunctionLayer, LayeredFunctionRegistry } from "./layered-registry.js";
import { isPiToolNamespace, type PiToolCatalog, withMissingPiTools } from "./pi-tools.js";

export interface FunctionDefinitionReference {
  id: string;
  layer: FunctionLayer;
}

export interface FunctionEnvironment {
  userFunctions?: ReadonlyMap<string, string>;
  projectFunctions?: ReadonlyMap<string, string>;
  sessionFunctions?: ReadonlyMap<string, string>;
  invalidDefinitions?: ReadonlyMap<string, string>;
  /** Pi tools callable now, bound under `tools`: the current call's, or the session's latest. */
  toolCatalog?: PiToolCatalog;
}

const MAX_CACHED_TOOL_REFERENCES = 256;
const toolReferenceCache = new Map<string, readonly string[]>();

/** Pi tool dependencies a saved source declares; malformed sources declare none here. */
function toolReferences(source: string): readonly string[] {
  const cached = toolReferenceCache.get(source);
  if (cached) return cached;
  let ids: string[] = [];
  try {
    ids = getFunctionDependencies(source)
      .dependencies.map(({ id }) => id)
      .filter((id) => isPiToolNamespace(id.split(".")[0] as string));
  } catch {
    // Validation reports malformed sources itself.
  }
  toolReferenceCache.set(source, ids);
  /* v8 ignore next 3 -- defensive cache capacity bound. */
  if (toolReferenceCache.size > MAX_CACHED_TOOL_REFERENCES) {
    toolReferenceCache.delete(toolReferenceCache.keys().next().value as string);
  }
  return ids;
}

/**
 * The environment's tool catalog, with placeholders for tools its saved functions inject that Pi
 * does not offer now. Functions named in the `tools` namespace provide their own ids.
 */
export function resolveToolCatalog(environment: FunctionEnvironment): PiToolCatalog | undefined {
  const layers = [
    environment.userFunctions,
    environment.projectFunctions,
    environment.sessionFunctions,
  ];
  const provided = new Set(layers.flatMap((sources) => Array.from(sources?.keys() ?? [])));
  const references = layers
    .flatMap((sources) => Array.from(sources?.values() ?? []))
    .flatMap(toolReferences)
    .filter((id) => !provided.has(id));
  return withMissingPiTools(environment.toolCatalog, references);
}

export function functionRegistry(
  environment: FunctionEnvironment,
  tools: PiToolCatalog | undefined = resolveToolCatalog(environment),
): LayeredFunctionRegistry<FunctionDefinition> {
  const definitions: FunctionDefinition[] = [];
  const add = (layer: FunctionLayer, sources?: ReadonlyMap<string, string>): void => {
    for (const [id, source] of [...(sources ?? [])].sort(([a], [b]) => a.localeCompare(b)))
      definitions.push({ id, layer, kind: "source", source });
  };
  add("user", environment.userFunctions);
  add("project", environment.projectFunctions);
  add("session", environment.sessionFunctions);
  return createLayeredFunctionRegistry(definitions, tools?.definitions);
}
