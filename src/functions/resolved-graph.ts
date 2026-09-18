import type { FunctionDefinition, SourceFunctionDefinition } from "./definitions.js";
import { getFunctionDependencies, type FunctionDependency } from "./dependencies.js";
import type { FunctionDefinitionReference } from "./environment.js";
import type { LayeredFunctionRegistry } from "./layered-registry.js";

export interface ResolvedFunctionDependency extends FunctionDependency {
  targetKey: string;
}

export interface ResolvedFunctionNode {
  key: string;
  definition: FunctionDefinition;
  dependencies: ResolvedFunctionDependency[];
  nextKey?: string;
}

export interface ResolvedFunctionGraph {
  roots: ResolvedFunctionDependency[];
  nodes: Map<string, ResolvedFunctionNode>;
  effects: string[];
  nextKey?: string;
  definition?: FunctionDefinitionReference;
}

export function definitionKey(definition: FunctionDefinition): string {
  return `${definition.layer}:${definition.id}`;
}

export function resolveFunctionGraph(
  source: string,
  registry: LayeredFunctionRegistry<FunctionDefinition>,
  options: {
    definition?: FunctionDefinitionReference;
    invalidDefinitions?: ReadonlyMap<string, string>;
  } = {},
): ResolvedFunctionGraph {
  const nodes = new Map<string, ResolvedFunctionNode>();
  const effects = new Set<string>();
  const visiting: string[] = [];

  const visit = (definition: FunctionDefinition): string => {
    const invalid = options.invalidDefinitions?.get(definition.id);
    if (invalid) throw new Error(`Function "${definition.id}" is unavailable: ${invalid}`);
    const key = definitionKey(definition);
    if (nodes.has(key)) return key;
    const cycleAt = visiting.indexOf(key);
    if (cycleAt >= 0) {
      const cycle = [...visiting.slice(cycleAt), key].map((entry) =>
        entry.split(":").slice(1).join(":"),
      );
      throw new Error(`function dependency cycle: ${cycle.join(" -> ")}`);
    }
    visiting.push(key);
    if (definition.kind === "native") {
      effects.add(definition.effect);
      nodes.set(key, { key, definition, dependencies: [] });
      visiting.pop();
      return key;
    }

    const declared = getFunctionDependencies(definition.source);
    const dependencies = declared.dependencies.map((dependency) => {
      const target = registry.resolve(dependency.id);
      if (!target) {
        throw new Error(
          `function "${definition.id}" requires unavailable dependency "${dependency.id}"`,
        );
      }
      return { id: dependency.id, localName: dependency.localName, targetKey: visit(target) };
    });
    let nextKey: string | undefined;
    if (declared.usesNext) {
      if (definition.layer === "global") {
        throw new Error(`global function "${definition.id}" cannot declare $next`);
      }
      const next = registry.resolveNext(definition.id, definition.layer);
      if (!next) {
        throw new Error(`function "${definition.id}" declares $next without a lower definition`);
      }
      nextKey = visit(next);
    }
    nodes.set(key, {
      key,
      definition,
      dependencies,
      ...(nextKey ? { nextKey } : {}),
    });
    visiting.pop();
    return key;
  };

  if (options.definition) {
    const definition = registry.get(options.definition.layer, options.definition.id);
    if (!definition || definition.kind !== "source" || definition.source !== source) {
      throw new Error("Submitted definition does not match the active function environment");
    }
    const key = visit(definition);
    const node = nodes.get(key) as ResolvedFunctionNode;
    nodes.delete(key);
    return {
      definition: options.definition,
      roots: node.dependencies,
      nodes,
      effects: [...effects].sort(),
      ...(node.nextKey ? { nextKey: node.nextKey } : {}),
    };
  }

  const rootDeclaration = getFunctionDependencies(source);
  if (rootDeclaration.usesNext) {
    throw new Error("submitted programs cannot declare $next");
  }
  const roots = rootDeclaration.dependencies.map((dependency) => {
    const invalid = options.invalidDefinitions?.get(dependency.id);
    if (invalid) throw new Error(`Function "${dependency.id}" is unavailable: ${invalid}`);
    const target = registry.resolve(dependency.id);
    if (!target) {
      throw new Error(`submitted program requires unavailable function "${dependency.id}"`);
    }
    return { id: dependency.id, localName: dependency.localName, targetKey: visit(target) };
  });
  return { roots, nodes, effects: [...effects].sort((left, right) => left.localeCompare(right)) };
}

export function sourceFunctionDefinition(
  id: string,
  layer: SourceFunctionDefinition["layer"],
  source: string,
): SourceFunctionDefinition {
  return { id, layer, kind: "source", source };
}
