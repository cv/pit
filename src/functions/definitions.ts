import { CAPABILITY_REGISTRY } from "../capabilities/registry.js";
import {
  type FunctionLayer,
  type LayeredFunctionDefinition,
  LayeredFunctionRegistry,
} from "./layered-registry.js";

export interface NativeFunctionDefinition extends LayeredFunctionDefinition {
  kind: "native";
  layer: "global";
  capability: string;
  method: string;
  effect: string;
}

export interface SourceFunctionDefinition extends LayeredFunctionDefinition {
  kind: "source";
  layer: FunctionLayer;
  source: string;
}

export type FunctionDefinition = NativeFunctionDefinition | SourceFunctionDefinition;

export function globalFunctionDefinitions(): NativeFunctionDefinition[] {
  return Object.entries(CAPABILITY_REGISTRY).flatMap(([capability, definition]) =>
    Object.keys(definition.methods).map((method) => ({
      id: `${capability}.${method}`,
      layer: "global" as const,
      kind: "native" as const,
      capability,
      method,
      effect: `${capability}.${method}`,
      sealed: capability === "functions",
    })),
  );
}

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
