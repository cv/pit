import type { FunctionDefinition } from "./definitions.js";
import { getFunctionDependencies, type FunctionDependency } from "./dependencies.js";
import type { FunctionDefinitionReference } from "./environment.js";
import { functionDependencyBinding } from "./identifier.js";
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

function namespaceDependencyHint(
  id: string,
  registry: LayeredFunctionRegistry<FunctionDefinition>,
): string | undefined {
  const example = registry.identifiers().find((candidate) => candidate.startsWith(`${id}.`));
  if (!example) return;
  return (
    `cannot inject namespace "${id}" as a function. ` +
    `Destructure individual functions in the first parameter, for example ${functionDependencyBinding(example)}, ` +
    "then call the bound function."
  );
}

/**
 * Fails when a graph reaches a placeholder for a tool Pi does not offer now. Validation keeps such
 * saved functions; only running them, or reporting their availability, needs this check. The
 * error names the saved function whose own dependency is missing.
 */
export function assertGraphAvailable(graph: ResolvedFunctionGraph): void {
  const reason = (key: string): string | undefined => {
    const definition = graph.nodes.get(key)?.definition;
    return definition?.kind === "native" ? definition.unavailable : undefined;
  };
  for (const root of graph.roots) {
    const missing = reason(root.targetKey);
    if (missing)
      throw new Error(`Function "${graph.definition?.id ?? root.id}" is unavailable: ${missing}`);
  }
  for (const node of graph.nodes.values()) {
    for (const dependency of node.dependencies) {
      const missing = reason(dependency.targetKey);
      if (missing) throw new Error(`Function "${node.definition.id}" is unavailable: ${missing}`);
    }
  }
}

function assertValid(
  invalidDefinitions: ReadonlyMap<string, string> | undefined,
  id: string,
  sealed: boolean | undefined,
): void {
  const invalid = invalidDefinitions?.get(id);
  if (invalid && !sealed) throw new Error(`Function "${id}" is unavailable: ${invalid}`);
}

function assertAcyclic(visiting: readonly string[], key: string): void {
  const cycleAt = visiting.indexOf(key);
  if (cycleAt < 0) return;
  const cycle = [...visiting.slice(cycleAt), key].map((entry) =>
    entry.split(":").slice(1).join(":"),
  );
  throw new Error(`function dependency cycle: ${cycle.join(" -> ")}`);
}

function nextDefinition(
  registry: LayeredFunctionRegistry<FunctionDefinition>,
  definition: FunctionDefinition,
): FunctionDefinition {
  if (definition.layer === "global") {
    throw new Error(`global function "${definition.id}" cannot declare $next`);
  }
  const next = registry.resolveNext(definition.id, definition.layer);
  if (!next) {
    throw new Error(`function "${definition.id}" declares $next without a lower definition`);
  }
  return next;
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

  /** Resolves one injected dependency of `requester`, visiting its target. */
  const edge = (
    dependency: FunctionDependency,
    requester: string,
    noun: string,
  ): ResolvedFunctionDependency => {
    const target = registry.resolve(dependency.id);
    if (!target) {
      throw new Error(
        `${requester} ${namespaceDependencyHint(dependency.id, registry) ?? `requires unavailable ${noun} "${dependency.id}"`}`,
      );
    }
    return { id: dependency.id, localName: dependency.localName, targetKey: visit(target) };
  };

  const node = (definition: FunctionDefinition, key: string): ResolvedFunctionNode => {
    if (definition.kind === "native") {
      effects.add(definition.effect);
      return { key, definition, dependencies: [] };
    }
    const declared = getFunctionDependencies(definition.source);
    const dependencies = declared.dependencies.map((dependency) =>
      edge(dependency, `function "${definition.id}"`, "dependency"),
    );
    const nextKey = declared.usesNext ? visit(nextDefinition(registry, definition)) : undefined;
    return { key, definition, dependencies, ...(nextKey ? { nextKey } : {}) };
  };

  const visit = (definition: FunctionDefinition): string => {
    assertValid(options.invalidDefinitions, definition.id, definition.sealed);
    const key = definitionKey(definition);
    if (nodes.has(key)) return key;
    assertAcyclic(visiting, key);
    visiting.push(key);
    nodes.set(key, node(definition, key));
    visiting.pop();
    return key;
  };

  if (options.definition) {
    const definition = registry.get(options.definition.layer, options.definition.id);
    if (!definition || definition.kind !== "source" || definition.source !== source) {
      throw new Error("Submitted definition does not match the active function environment");
    }
    const key = visit(definition);
    const root = nodes.get(key) as ResolvedFunctionNode;
    nodes.delete(key);
    return {
      definition: options.definition,
      roots: root.dependencies,
      nodes,
      effects: [...effects].sort(),
      ...(root.nextKey ? { nextKey: root.nextKey } : {}),
    };
  }

  const rootDeclaration = getFunctionDependencies(source);
  if (rootDeclaration.usesNext) {
    throw new Error("submitted programs cannot declare $next");
  }
  const roots = rootDeclaration.dependencies.map((dependency) => {
    assertValid(options.invalidDefinitions, dependency.id, registry.resolve(dependency.id)?.sealed);
    return edge(dependency, "submitted program", "function");
  });
  return { roots, nodes, effects: [...effects].sort((left, right) => left.localeCompare(right)) };
}
