import type { SourceFunctionDefinition } from "../../src/functions/definitions.js";

/** Builds a source function definition for registry and graph fixtures. */
export function sourceFunctionDefinition(
  id: string,
  layer: SourceFunctionDefinition["layer"],
  source: string,
): SourceFunctionDefinition {
  return { id, layer, kind: "source", source };
}
