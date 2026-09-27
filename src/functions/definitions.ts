import type { NativeFunctionDefinition, FunctionMetadata } from "./global-definition.js";
import { globalFunctionDefinitions, getGlobalFunction } from "./globals.js";
import {
  type FunctionLayer,
  type LayeredFunctionDefinition,
  LayeredFunctionRegistry,
} from "./layered-registry.js";

export type { NativeFunctionDefinition } from "./global-definition.js";
export { globalFunctionDefinitions } from "./globals.js";

export interface SourceFunctionDefinition
  extends LayeredFunctionDefinition, Partial<FunctionMetadata> {
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
  return getGlobalFunction(id)?.sealed ?? false;
}
