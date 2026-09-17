import { validateFunctionId, validateFunctionNamespaces } from "./identifier.js";

export const FUNCTION_LAYERS = ["global", "user", "project", "session"] as const;
export type FunctionLayer = (typeof FUNCTION_LAYERS)[number];

const RESOLUTION_ORDER = [...FUNCTION_LAYERS].reverse();

export interface LayeredFunctionDefinition {
  id: string;
  layer: FunctionLayer;
  sealed?: boolean;
}

export interface ResolvedFunctionDefinition<Definition extends LayeredFunctionDefinition> {
  effective: Definition;
  chain: Definition[];
}

export class LayeredFunctionRegistry<Definition extends LayeredFunctionDefinition> {
  readonly #layers = new Map<FunctionLayer, Map<string, Definition>>(
    FUNCTION_LAYERS.map((layer) => [layer, new Map()]),
  );

  set(definition: Definition): void {
    validateFunctionId(definition.id);
    if (definition.layer !== "global" && this.#layers.get("global")?.get(definition.id)?.sealed) {
      throw new Error(`global function "${definition.id}" is sealed and cannot be overridden`);
    }
    const candidateIds = new Set(this.identifiers());
    candidateIds.add(definition.id);
    validateFunctionNamespaces(candidateIds);
    this.#layer(definition.layer).set(definition.id, definition);
  }

  delete(layer: Exclude<FunctionLayer, "global">, id: string): boolean {
    validateFunctionId(id);
    return this.#layer(layer).delete(id);
  }

  clear(layer: Exclude<FunctionLayer, "global">): void {
    this.#layer(layer).clear();
  }

  get(layer: FunctionLayer, id: string): Definition | undefined {
    return this.#layer(layer).get(id);
  }

  resolve(id: string): Definition | undefined {
    validateFunctionId(id);
    for (const layer of RESOLUTION_ORDER) {
      const definition = this.#layer(layer).get(id);
      if (definition) return definition;
    }
  }

  resolveNext(id: string, layer: Exclude<FunctionLayer, "global">): Definition | undefined {
    validateFunctionId(id);
    if (!this.#layer(layer).has(id)) return;
    const index = FUNCTION_LAYERS.indexOf(layer);
    for (let candidate = index - 1; candidate >= 0; candidate--) {
      const definition = this.#layer(FUNCTION_LAYERS[candidate] as FunctionLayer).get(id);
      if (definition) return definition;
    }
  }

  resolved(id: string): ResolvedFunctionDefinition<Definition> | undefined {
    const chain = this.chain(id);
    const effective = chain[0];
    return effective ? { effective, chain } : undefined;
  }

  chain(id: string): Definition[] {
    validateFunctionId(id);
    return RESOLUTION_ORDER.flatMap((layer) => {
      const definition = this.#layer(layer).get(id);
      return definition ? [definition] : [];
    });
  }

  identifiers(): string[] {
    return [...new Set(FUNCTION_LAYERS.flatMap((layer) => [...this.#layer(layer).keys()]))].sort(
      (left, right) => left.localeCompare(right),
    );
  }

  effective(): Map<string, Definition> {
    return new Map(
      this.identifiers().flatMap((id) => {
        const definition = this.resolve(id);
        /* v8 ignore next -- identifiers are collected from definitions in these same layers. */
        return definition ? [[id, definition] as const] : [];
      }),
    );
  }

  definitions(): Definition[] {
    const definitions: Definition[] = [];
    for (const layer of FUNCTION_LAYERS) {
      definitions.push(...this.#layer(layer).values());
    }
    return definitions;
  }

  #layer(layer: FunctionLayer): Map<string, Definition> {
    return this.#layers.get(layer) as Map<string, Definition>;
  }
}
