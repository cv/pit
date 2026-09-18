import { createLayeredFunctionRegistry, type FunctionDefinition } from "./definitions.js";
import type { FunctionLayer, LayeredFunctionRegistry } from "./layered-registry.js";

export interface FunctionDefinitionReference {
  id: string;
  layer: FunctionLayer;
}

export interface FunctionEnvironment {
  userFunctions?: ReadonlyMap<string, string>;
  projectFunctions?: ReadonlyMap<string, string>;
  sessionFunctions?: ReadonlyMap<string, string>;
  invalidDefinitions?: ReadonlyMap<string, string>;
}

export function functionRegistry(
  environment: FunctionEnvironment,
): LayeredFunctionRegistry<FunctionDefinition> {
  const definitions: FunctionDefinition[] = [];
  const add = (layer: FunctionLayer, sources?: ReadonlyMap<string, string>): void => {
    for (const [id, source] of [...(sources ?? [])].sort(([a], [b]) => a.localeCompare(b)))
      definitions.push({ id, layer, kind: "source", source });
  };
  add("user", environment.userFunctions);
  add("project", environment.projectFunctions);
  add("session", environment.sessionFunctions);
  return createLayeredFunctionRegistry(definitions);
}
