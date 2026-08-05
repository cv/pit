import { getSavedFunctionDependencyGraph } from "./saved-function-graph.js";
import type { FunctionScope } from "./saved-functions.js";

interface ScopedFunctionDefinition {
  key: string;
  name: string;
  scope: FunctionScope;
  source: string;
  dependencies: Array<{ name: string; key: string }>;
}

export interface ScopedFunctionRegistries {
  global: ReadonlyMap<string, string>;
  project: ReadonlyMap<string, string>;
  session: ReadonlyMap<string, string>;
}

function availableRegistry(registries: ScopedFunctionRegistries, scope: FunctionScope) {
  if (scope === "global") return new Map(registries.global);
  if (scope === "project") return new Map([...registries.global, ...registries.project]);
  return new Map([...registries.global, ...registries.project, ...registries.session]);
}

function scopedSource(registries: ScopedFunctionRegistries, name: string, scope: FunctionScope) {
  if (scope === "session" && registries.session.has(name)) {
    return { source: registries.session.get(name) as string, scope: "session" as const };
  }
  if (scope !== "global" && registries.project.has(name)) {
    return { source: registries.project.get(name) as string, scope: "project" as const };
  }
  const source = registries.global.get(name);
  return source === undefined ? undefined : { source, scope: "global" as const };
}

function scopedDefinitions(
  source: string,
  effective: ReadonlyMap<string, string>,
  scopes: ReadonlyMap<string, FunctionScope>,
  registries: ScopedFunctionRegistries,
) {
  const definitions = new Map<string, ScopedFunctionDefinition>();
  const visit = (name: string, scope: FunctionScope): string | undefined => {
    const selected = scopedSource(registries, name, scope);
    if (!selected) return;
    const key = `${selected.scope}:${name}`;
    if (definitions.has(key)) return key;
    const definition: ScopedFunctionDefinition = {
      key,
      name,
      scope: selected.scope,
      source: selected.source,
      dependencies: [],
    };
    definitions.set(key, definition);
    const graph = getSavedFunctionDependencyGraph(availableRegistry(registries, selected.scope));
    for (const dependencyName of graph.directReferences(selected.source)) {
      const dependencyKey = visit(dependencyName, selected.scope);
      if (dependencyKey) definition.dependencies.push({ name: dependencyName, key: dependencyKey });
    }
    return key;
  };
  const roots = new Map<string, string>();
  const graph = getSavedFunctionDependencyGraph(effective);
  for (const name of graph.directReferences(source)) {
    const key = visit(name, scopes.get(name) ?? "session");
    if (key) roots.set(name, key);
  }
  return { definitions: [...definitions.values()], roots };
}

function renderRuntime(
  source: string,
  programExpression: boolean,
  definitions: readonly ScopedFunctionDefinition[],
  roots: ReadonlyMap<string, string>,
): string {
  const indexes = new Map(definitions.map((definition, index) => [definition.key, index]));
  const declarations = definitions.map((_, index) => `let __pit_scoped_${index};`);
  const assignments = definitions.map((definition, index) => {
    const dependencies = definition.dependencies.map(
      ({ name, key }) =>
        `const ${name} = async (__pit_input) => __pit_scoped_${indexes.get(key)}(__pit_input);`,
    );
    return `__pit_scoped_${index} = (() => { ${dependencies.join("\n")} const __pit_saved = (${definition.source}); return async (__pit_input) => __pit_run_saved(${JSON.stringify(definition.name)}, ${JSON.stringify(definition.scope)}, async () => { await __pit_capabilities.__pit.savedFunctionRun(${JSON.stringify(definition.name)}); try { return await __pit_saved(__pit_capabilities, __pit_input); } catch (__pit_error) { throw new Error(${JSON.stringify(`Saved function "${definition.name}" failed: `)} + (__pit_error?.message ?? String(__pit_error)), { cause: __pit_error }); } }); })();`;
  });
  const bindings = [...roots].map(
    ([name, key]) => `const ${name} = __pit_scoped_${indexes.get(key)};`,
  );
  const invocation = programExpression
    ? `const __pit_submission = (${source}); return await __pit_submission(__pit_capabilities, __pit_input);`
    : `return await (${source});`;
  return `async (__pit_capabilities, __pit_input, __pit_run_saved) => { ${declarations.join("\n")} ${assignments.join("\n")} ${bindings.join("\n")} ${invocation} }`;
}

export function scopedRuntimeProgram(input: {
  source: string;
  programExpression: boolean;
  effective: ReadonlyMap<string, string>;
  scopes: ReadonlyMap<string, FunctionScope>;
  registries: ScopedFunctionRegistries;
}): string {
  const resolved = scopedDefinitions(input.source, input.effective, input.scopes, input.registries);
  return renderRuntime(input.source, input.programExpression, resolved.definitions, resolved.roots);
}
