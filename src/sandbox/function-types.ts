import type { FunctionDefinition, SourceFunctionDefinition } from "../functions/definitions.js";
import { getFunctionDependencies } from "../functions/dependencies.js";
import type { FunctionDefinitionReference } from "../functions/environment.js";
import type { LayeredFunctionRegistry } from "../functions/layered-registry.js";
import { definitionKey } from "../functions/resolved-graph.js";
import { getFunctionTypeParameters } from "../functions/source.js";

interface DependencyTypeNode {
  type?: string;
  children: Map<string, DependencyTypeNode>;
}

function dependencyType(
  entries: Array<[string, string]>,
  baseType = "PitBuiltinCapabilities",
): string {
  const root: DependencyTypeNode = { children: new Map() };
  for (const [id, type] of entries) {
    let node = root;
    for (const segment of id.split(".")) {
      let child = node.children.get(segment);
      if (!child) {
        child = { children: new Map() };
        node.children.set(segment, child);
      }
      node = child;
    }
    node.type = type;
  }
  const render = (node: DependencyTypeNode, base: string): string => {
    if (node.type) return node.type;
    if (!node.children.size) return base;
    const keys = [...node.children.keys()].map((key) => JSON.stringify(key)).join(" | ");
    const properties = [...node.children].map(([key, child]) => {
      const quoted = JSON.stringify(key);
      return `${quoted}: ${render(child, `PitProperty<${base}, ${quoted}>`)};`;
    });
    return `Omit<${base}, ${keys}> & { ${properties.join(" ")} }`;
  };
  return render(root, baseType);
}

function lowerDefinition(
  registry: LayeredFunctionRegistry<FunctionDefinition>,
  definition: FunctionDefinition,
) {
  return definition.layer === "global"
    ? undefined
    : registry.resolveNext(definition.id, definition.layer);
}

function selectedDefinitions(
  source: string,
  registry: LayeredFunctionRegistry<FunctionDefinition>,
  options: { definition?: FunctionDefinitionReference; checkAll: boolean },
): SourceFunctionDefinition[] {
  const selected = new Map<string, SourceFunctionDefinition>();
  const add = (definition: FunctionDefinition | undefined): void => {
    if (!definition || definition.kind === "native") return;
    const key = definitionKey(definition);
    if (selected.has(key)) return;
    selected.set(key, definition);
    add(lowerDefinition(registry, definition));
    for (const dependency of getFunctionDependencies(definition.source).dependencies) {
      add(registry.resolve(dependency.id));
    }
  };
  if (options.checkAll) {
    for (const definition of registry.definitions()) add(definition);
  } else if (options.definition) {
    add(registry.get(options.definition.layer, options.definition.id));
  } else {
    for (const dependency of getFunctionDependencies(source).dependencies)
      add(registry.resolve(dependency.id));
  }
  return [...selected.values()].sort((a, b) => definitionKey(a).localeCompare(definitionKey(b)));
}

export function functionTypeModel(
  source: string,
  registry: LayeredFunctionRegistry<FunctionDefinition>,
  options: {
    definition?: FunctionDefinitionReference;
    checkAll: boolean;
    checkCompatibility: boolean;
  },
): { declarations: string; signatures: string; rootDependencies: string } {
  const definitions = selectedDefinitions(source, registry, options);
  const indexes = new Map(
    definitions.map((definition, index) => [definitionKey(definition), index]),
  );
  const publicType = (definition: FunctionDefinition): string => {
    if (definition.kind === "native")
      return `PitBuiltinCapabilities[${JSON.stringify(definition.capability)}][${JSON.stringify(definition.method)}]`;
    const parameters = getFunctionTypeParameters(definition.source);
    const signature = `typeof __pit_signature_${indexes.get(definitionKey(definition))}${parameters.arguments}`;
    return `(${parameters.declaration}(...args: PitInjectedArguments<${signature}>) => Promise<Awaited<ReturnType<${signature}>>>)`;
  };
  const dependenciesType = (definition: SourceFunctionDefinition): string => {
    const declared = getFunctionDependencies(definition.source);
    const entries: Array<[string, string]> = declared.dependencies.flatMap((dependency) => {
      const target = registry.resolve(dependency.id);
      return target ? [[dependency.id, publicType(target)] as [string, string]] : [];
    });
    if (declared.usesNext) {
      const lower = lowerDefinition(registry, definition);
      if (!lower)
        throw new Error(`function "${definition.id}" declares $next without a lower definition`);
      entries.push(["$next", publicType(lower)]);
    }
    return dependencyType(entries, "{}");
  };
  const entries: Array<[string, string]> = definitions
    .filter((definition) => registry.resolve(definition.id) === definition)
    .map((definition) => [definition.id, publicType(definition)]);
  const declarations = `type PitInjectedArguments<T extends (...args: any[]) => any> = Parameters<T> extends [any, ...infer Rest] ? Rest : [];
type PitRequiredArguments<T extends any[]> = T extends [any, ...infer Rest] ? [unknown, ...PitRequiredArguments<Rest>] : [];
type PitProperty<T, K extends PropertyKey> = K extends keyof T ? T[K] : {};
type PitSourceProgram<D> = (dependencies: D, ...args: any[]) => PitResult | void | Promise<PitResult | void>;
type PitCapabilities = ${dependencyType(entries)};`;
  const signatures = definitions
    .map((definition, index) => {
      const lines = [
        `const __pit_signature_${index} = (${definition.source}) satisfies PitSourceProgram<${dependenciesType(definition)}>;`,
      ];
      const lower = lowerDefinition(registry, definition);
      if (options.checkCompatibility && lower) {
        lines.push(
          `const __pit_arity_${index}: true = null as unknown as (PitRequiredArguments<Parameters<${publicType(lower)}>> extends [...PitRequiredArguments<Parameters<${publicType(definition)}>>, ...unknown[]] ? true : false); // Required arguments: ${definition.id}`,
        );
        lines.push(
          `const __pit_override_${index}: ${publicType(lower)} = null as unknown as ${publicType(definition)}; // Override ${definition.id} (${definition.layer} -> ${lower.layer})`,
        );
      }
      return lines.join("\n");
    })
    .join("\n");
  const root = options.definition
    ? registry.get(options.definition.layer, options.definition.id)
    : undefined;
  const rootDependencies = root?.kind === "source" ? dependenciesType(root) : "PitCapabilities";
  return { declarations, signatures: signatures || "void 0;", rootDependencies };
}
