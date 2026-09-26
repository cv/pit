import {
  type FunctionLayer,
  type LayeredFunctionDefinition,
  LayeredFunctionRegistry,
} from "./layered-registry.js";
import type { NativeFunctionDefinition } from "./native-definition.js";
import { globalFunctionDefinitions, getNativeFunction } from "./native.js";

export type { NativeFunctionDefinition } from "./native-definition.js";
export { globalFunctionDefinitions } from "./native.js";

export interface SourceFunctionDefinition extends LayeredFunctionDefinition {
  kind: "source";
  layer: FunctionLayer;
  source: string;
}

export type FunctionDefinition = NativeFunctionDefinition | SourceFunctionDefinition;

export function createLayeredFunctionRegistry(
  definitions: Iterable<FunctionDefinition> = [],
): LayeredFunctionRegistry<FunctionDefinition> {
  const registry = new LayeredFunctionRegistry<FunctionDefinition>();
  for (const definition of globalFunctionDefinitions()) {
    registry.set(definition);
  }
  for (const definition of definitions) {
    registry.set(definition);
  }
  return registry;
}

export function isSealedGlobalFunction(id: string): boolean {
  return getNativeFunction(id)?.sealed ?? false;
}
