import { validateTypeScript } from "../sandbox/validation.js";
import { type FunctionRegistry, validateEffectiveRegistryCapacity } from "./core.js";
import { getFunctionDependencies } from "./dependencies.js";
import { getSavedFunctionDependencyGraph } from "./graph.js";
import {
  getSavedFunctionCallSignature,
  type PersistentFunctionMetadata,
  type PersistentFunctionMetadataRegistry,
} from "./source.js";

const MAX_PROJECT_CATALOG_BYTES = 12_000;
const MAX_PROJECT_FUNCTIONS = 64;

export function savedFunctionDependents(
  projectCandidates: ReadonlyMap<string, string>,
  session: ReadonlyMap<string, string>,
  effective: ReadonlyMap<string, string>,
  name: string,
): { direct: string[]; transitive: string[] } {
  type ScopedFunction = { name: string; scope: "project" | "session"; source: string };
  const key = (scope: ScopedFunction["scope"], functionName: string) => `${scope}:${functionName}`;
  const target = key("project", name);
  const functions = new Map<string, ScopedFunction>();
  for (const [functionName, source] of projectCandidates) {
    functions.set(key("project", functionName), {
      name: functionName,
      scope: "project",
      source,
    });
  }
  for (const [functionName, source] of session) {
    functions.set(key("session", functionName), {
      name: functionName,
      scope: "session",
      source,
    });
  }

  const projectGraph = getSavedFunctionDependencyGraph(projectCandidates);
  const effectiveGraph = getSavedFunctionDependencyGraph(effective);

  const dependencies = new Map<string, Set<string>>();
  for (const [functionKey, candidate] of functions) {
    const graph = candidate.scope === "project" ? projectGraph : effectiveGraph;
    const references = graph.directDependencies(candidate.name);
    dependencies.set(
      functionKey,
      new Set(
        references.map((reference) =>
          candidate.scope === "session" && session.has(reference)
            ? key("session", reference)
            : key("project", reference),
        ),
      ),
    );
  }

  const reachesTarget = (functionKey: string, visiting = new Set<string>()): boolean => {
    if (visiting.has(functionKey)) {
      return false;
    }
    visiting.add(functionKey);
    for (const dependency of dependencies.get(functionKey) as Set<string>) {
      if (dependency === target || reachesTarget(dependency, visiting)) {
        visiting.delete(functionKey);
        return true;
      }
    }
    visiting.delete(functionKey);
    return false;
  };

  const direct = new Set<string>();
  const transitive = new Set<string>();
  for (const [functionKey, candidate] of functions) {
    if (functionKey === target) {
      continue;
    }
    if (dependencies.get(functionKey)?.has(target)) {
      direct.add(candidate.name);
      transitive.delete(candidate.name);
    } else if (!direct.has(candidate.name) && reachesTarget(functionKey)) {
      transitive.add(candidate.name);
    }
  }
  return {
    direct: [...direct].sort((a, b) => a.localeCompare(b)),
    transitive: [...transitive].sort((a, b) => a.localeCompare(b)),
  };
}

interface ProjectClosureContext {
  candidates: ReadonlyMap<string, string>;
  registry: FunctionRegistry;
  candidateGraph: ReturnType<typeof getSavedFunctionDependencyGraph>;
}

function requiredProjectSource(candidates: ReadonlyMap<string, string>, name: string): string {
  const source = candidates.get(name);
  if (source === undefined) {
    throw new Error(`required project function "${name}" is unavailable`);
  }
  return source;
}

function projectClosure(
  context: ProjectClosureContext,
  roots: readonly string[],
  sessionFunctions: ReadonlyMap<string, string>,
  forceRoots = false,
): string[] {
  const ordered: string[] = [];
  const selected = new Set<string>();
  const visiting = new Set<string>();
  const visit = (name: string, force: boolean): void => {
    if (
      (!force && sessionFunctions.has(name)) ||
      context.registry.has(name) ||
      selected.has(name)
    ) {
      return;
    }
    requiredProjectSource(context.candidates, name);
    if (visiting.has(name)) {
      return;
    }
    visiting.add(name);
    for (const dependency of context.candidateGraph.directDependencies(name)) {
      if (context.candidates.has(dependency)) {
        visit(dependency, false);
      }
    }
    visiting.delete(name);
    selected.add(name);
    ordered.push(name);
  };
  for (const root of [...roots].sort((a, b) => a.localeCompare(b))) {
    visit(root, forceRoots);
  }
  return ordered;
}

export interface ProjectFunctionReconciliation {
  user: ReadonlyMap<string, string>;
  candidates: ReadonlyMap<string, string>;
  candidateMetadata: ReadonlyMap<string, PersistentFunctionMetadata>;
  session: FunctionRegistry;
  registry: FunctionRegistry;
  metadata: PersistentFunctionMetadataRegistry;
}

export function reconcileProjectFunctionsForSession({
  user,
  candidates,
  candidateMetadata,
  session,
  registry,
  metadata,
}: ProjectFunctionReconciliation): string[] {
  const sessionCandidates = new Map(session);
  const candidateGraph = getSavedFunctionDependencyGraph(new Map([...user, ...candidates]));
  const closureContext: ProjectClosureContext = { candidates, registry, candidateGraph };
  const availableCandidates = new Map([...user, ...candidates, ...sessionCandidates]);
  const availableGraph = getSavedFunctionDependencyGraph(availableCandidates);
  session.clear();
  registry.clear();
  metadata.clear();
  const errors: string[] = [];

  const proposedProject = (additions: readonly string[]): FunctionRegistry => {
    const project = new Map(registry);
    for (const name of additions) project.set(name, requiredProjectSource(candidates, name));
    return project;
  };
  const proposedEffective = (
    additions: readonly string[],
    sessionFunctions: ReadonlyMap<string, string>,
  ): FunctionRegistry => new Map([...user, ...proposedProject(additions), ...sessionFunctions]);

  const commitProjects = (names: readonly string[]): void => {
    for (const name of names) {
      registry.set(name, requiredProjectSource(candidates, name));
      const parsed = candidateMetadata.get(name);
      if (parsed) {
        metadata.set(name, parsed);
      }
    }
  };

  for (const [name, source] of sessionCandidates) {
    try {
      const proposedSession = new Map(session);
      proposedSession.set(name, source);
      const roots = availableGraph
        .directReferences(source)
        .filter((reference) => !proposedSession.has(reference) && candidates.has(reference));
      if (getFunctionDependencies(source).usesNext && candidates.has(name)) roots.push(name);
      const additions = projectClosure(closureContext, roots, proposedSession, true);
      const effective = proposedEffective(additions, proposedSession);
      validateEffectiveRegistryCapacity(effective);
      validateTypeScript(source, effective, undefined, {
        environment: {
          userFunctions: user,
          projectFunctions: proposedProject(additions),
          sessionFunctions: proposedSession,
        },
        definition: { id: name, layer: "session" },
        checkAll: false,
      });
      commitProjects(additions);
      session.set(name, source);
    } catch (error) {
      errors.push(`session function ${name}: ${(error as Error).message}`);
    }
  }

  for (const name of candidates.keys()) {
    if (registry.has(name)) {
      continue;
    }
    try {
      const additions = projectClosure(closureContext, [name], session, true);
      validateEffectiveRegistryCapacity(proposedEffective(additions, session));
      commitProjects(additions);
    } catch (error) {
      errors.push(`${name}.ts: ${(error as Error).message}`);
    }
  }
  return errors;
}

function persistentFunctionCatalog(
  metadata: ReadonlyMap<string, PersistentFunctionMetadata>,
  sessionFunctions: ReadonlyMap<string, string>,
  scope: "user" | "project",
): string {
  if (metadata.size === 0) {
    return "";
  }
  const title = scope === "user" ? "User" : "Project";
  const lines = [`## ${title} functions`];
  const entries = [...metadata.values()].sort((a, b) => a.name.localeCompare(b.name));
  let shown = 0;
  for (const entry of entries) {
    /* v8 ignore next -- defensive bound for unusually large persistent catalogs */
    if (shown >= MAX_PROJECT_FUNCTIONS) {
      break;
    }
    const isSessionOverride = sessionFunctions.has(entry.name);
    const effectiveSignature = isSessionOverride
      ? getSavedFunctionCallSignature(sessionFunctions.get(entry.name) ?? "", entry.name)
      : entry.signature;
    const addition = isSessionOverride
      ? [`- ${effectiveSignature ?? entry.name} — Session override of ${scope} function.`]
      : [`- ${entry.signature} — ${entry.summary.replace(/\s+/g, " ").trim()}`];
    const parameters = isSessionOverride ? [] : entry.parameters;
    for (const parameter of parameters) {
      const description = parameter.description
        ? `: ${parameter.description.replace(/\s+/g, " ").trim()}`
        : "";
      addition.push(`  - ${parameter.name}${description}`);
    }
    if (Buffer.byteLength([...lines, ...addition].join("\n")) > MAX_PROJECT_CATALOG_BYTES) {
      break;
    }
    lines.push(...addition);
    shown++;
  }
  if (shown < entries.length) {
    const method = scope === "user" ? "listUser" : "list";
    lines.push(
      `- … ${entries.length - shown} more; use functions.${method}() for the complete catalog.`,
    );
  }
  return lines.join("\n");
}

export function projectFunctionCatalog(
  metadata: ReadonlyMap<string, PersistentFunctionMetadata>,
  sessionFunctions: ReadonlyMap<string, string> = new Map(),
): string {
  return persistentFunctionCatalog(metadata, sessionFunctions, "project");
}

export function userFunctionCatalog(
  metadata: ReadonlyMap<string, PersistentFunctionMetadata>,
  projectFunctions: ReadonlyMap<string, string>,
  sessionFunctions: ReadonlyMap<string, string>,
): string {
  const effectiveMetadata = new Map(
    [...metadata].filter(([name]) => !projectFunctions.has(name) && !sessionFunctions.has(name)),
  );
  return persistentFunctionCatalog(effectiveMetadata, new Map(), "user");
}
