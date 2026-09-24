import type { FunctionDefinition } from "./definitions.js";
import type {
  ResolvedFunctionDependency,
  ResolvedFunctionGraph,
  ResolvedFunctionNode,
} from "./resolved-graph.js";

interface DependencyTree {
  children: Map<string, DependencyTree>;
  target?: string;
}

function dependencyTree(
  dependencies: readonly ResolvedFunctionDependency[],
  nextTarget?: string,
): DependencyTree {
  const root: DependencyTree = { children: new Map() };
  const insert = (id: string, target: string): void => {
    const segments = id.split(".");
    let current = root;
    for (const segment of segments) {
      const child = current.children.get(segment) ?? {
        children: new Map<string, DependencyTree>(),
      };
      current.children.set(segment, child);
      current = child;
    }
    current.target = target;
  };
  for (const dependency of dependencies) {
    insert(dependency.id, dependency.targetKey);
  }
  if (nextTarget) insert("$next", nextTarget);
  return root;
}

function renderDependencyTree(tree: DependencyTree, indexes: ReadonlyMap<string, number>): string {
  if (tree.target) {
    const index = indexes.get(tree.target);
    /* v8 ignore next -- graph nodes and dependency targets are produced together. */
    if (index === undefined)
      throw new Error(`resolved function node "${tree.target}" is unavailable`);
    return `__pit_function_${index}`;
  }
  const properties = [...tree.children]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, child]) => `${JSON.stringify(name)}: ${renderDependencyTree(child, indexes)}`);
  return `__pit_dependency_object({${properties.join(",")}})`;
}

function renderNativeAssignment(
  index: number,
  definition: Extract<FunctionDefinition, { kind: "native" }>,
): string {
  return `__pit_function_${index} = (...__pit_args) => __pit_capabilities[${JSON.stringify(definition.capability)}][${JSON.stringify(definition.method)}](...__pit_args);`;
}

function renderSourceAssignment(
  index: number,
  node: ResolvedFunctionNode,
  indexes: ReadonlyMap<string, number>,
): string {
  /* v8 ignore next -- callers dispatch native definitions to the native renderer. */
  if (node.definition.kind !== "source") throw new Error("expected a source definition");
  const dependencies = renderDependencyTree(
    dependencyTree(node.dependencies, node.nextKey),
    indexes,
  );
  const name = JSON.stringify(node.definition.id);
  const layer = JSON.stringify(node.definition.layer);
  const prefix = JSON.stringify(`Function "${node.definition.id}" failed: `);
  return `__pit_function_${index} = (() => {
    const __pit_implementation = (${node.definition.source});
    const __pit_dependencies = ${dependencies};
    return async (...__pit_args) => __pit_run_saved(${name}, ${layer}, async () => {
      await __pit_capabilities.__pit.savedFunctionRun(${name});
      try {
        return await __pit_implementation(__pit_dependencies, ...__pit_args);
      } catch (__pit_error) {
        const __pit_failure = new Error(${prefix} + (__pit_error?.message ?? String(__pit_error)), { cause: __pit_error });
        // Keep the name so termination kinds such as TimeoutError survive the wrapper.
        if (typeof __pit_error?.name === "string") __pit_failure.name = __pit_error.name;
        throw __pit_failure;
      }
    });
  })();`;
}

export function unifiedRuntimeProgram(source: string, graph: ResolvedFunctionGraph): string {
  const nodes = [...graph.nodes.values()];
  const indexes = new Map(nodes.map((node, index) => [node.key, index]));
  const declarations = nodes.map((_, index) => `let __pit_function_${index};`);
  const assignments = nodes.map((node, index) =>
    node.definition.kind === "native"
      ? renderNativeAssignment(index, node.definition)
      : renderSourceAssignment(index, node, indexes),
  );
  const rootDependencies = renderDependencyTree(
    dependencyTree(graph.roots, graph.nextKey),
    indexes,
  );
  const invocation = `__pit_submission(${rootDependencies}, __pit_input)`;
  const execution = graph.definition
    ? `__pit_run_saved(${JSON.stringify(graph.definition.id)}, ${JSON.stringify(graph.definition.layer)}, () => ${invocation})`
    : invocation;
  return `async (__pit_capabilities, __pit_input, __pit_run_saved) => {
    const __pit_dependency_object = (__pit_values) => Object.freeze(Object.assign(Object.create(null), __pit_values));
    ${declarations.join("\n")}
    ${assignments.join("\n")}
    const __pit_submission = (${source});
    return await ${execution};
  }`;
}
