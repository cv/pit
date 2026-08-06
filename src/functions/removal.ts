import type { FunctionScope } from "./core.js";
import { getSavedFunctionDependencyGraph } from "./graph.js";
import { savedFunctionDependents } from "./persistent-functions.js";
import type { FunctionState } from "./state.js";

export interface SavedFunctionRemovalPlan {
  name: string;
  scope: FunctionScope;
  directDependents: string[];
  transitiveDependents: string[];
  removalClosure: string[];
  requiresCascade: boolean;
  blocked: boolean;
}

function selectedScope(
  state: FunctionState,
  name: string,
  requestedScope?: FunctionScope,
): FunctionScope {
  const scope =
    requestedScope ??
    (state.session.has(name)
      ? "session"
      : state.projectCandidates.has(name)
        ? "project"
        : state.global.has(name)
          ? "global"
          : undefined);
  if (scope === undefined) {
    throw new Error(`Saved function "${name}" was not found`);
  }
  return scope;
}

function sessionRemovalPlan(state: FunctionState, name: string): SavedFunctionRemovalPlan {
  if (!state.session.has(name)) {
    throw new Error(`Session function "${name}" was not found`);
  }
  const dependents = getSavedFunctionDependencyGraph(state.effective).dependents(name);
  const directDependents = dependents.direct.filter((candidate) => state.session.has(candidate));
  const transitiveDependents = dependents.transitive.filter((candidate) =>
    state.session.has(candidate),
  );
  return {
    name,
    scope: "session",
    directDependents,
    transitiveDependents,
    removalClosure: [name, ...directDependents, ...transitiveDependents].sort((a, b) =>
      a.localeCompare(b),
    ),
    requiresCascade: directDependents.length > 0 || transitiveDependents.length > 0,
    blocked: false,
  };
}

function globalRemovalPlan(state: FunctionState, name: string): SavedFunctionRemovalPlan {
  if (!state.global.has(name)) {
    throw new Error(`Global function "${name}" was not found`);
  }
  const globalDependents = getSavedFunctionDependencyGraph(state.global).dependents(name);
  const effectiveDependents =
    state.effective.get(name) === state.global.get(name)
      ? getSavedFunctionDependencyGraph(state.effective).dependents(name)
      : { direct: [], transitive: [] };
  const directDependents = [...new Set([...globalDependents.direct, ...effectiveDependents.direct])]
    .filter((candidate) => candidate !== name)
    .sort((a, b) => a.localeCompare(b));
  const transitiveDependents = [
    ...new Set([...globalDependents.transitive, ...effectiveDependents.transitive]),
  ]
    .filter((candidate) => candidate !== name && !directDependents.includes(candidate))
    .sort((a, b) => a.localeCompare(b));
  return {
    name,
    scope: "global",
    directDependents,
    transitiveDependents,
    removalClosure: [name],
    requiresCascade: false,
    blocked: directDependents.length > 0 || transitiveDependents.length > 0,
  };
}

function projectRemovalPlan(state: FunctionState, name: string): SavedFunctionRemovalPlan {
  if (!state.projectCandidates.has(name)) {
    throw new Error(`Project function "${name}" was not found`);
  }
  const dependents = savedFunctionDependents(
    state.projectCandidates,
    state.session,
    state.effective,
    name,
  );
  return {
    name,
    scope: "project",
    directDependents: dependents.direct,
    transitiveDependents: dependents.transitive,
    removalClosure: [name],
    requiresCascade: false,
    blocked: dependents.direct.length > 0 || dependents.transitive.length > 0,
  };
}

export function planSavedFunctionRemoval(
  state: FunctionState,
  name: string,
  requestedScope?: FunctionScope,
): SavedFunctionRemovalPlan {
  const scope = selectedScope(state, name, requestedScope);
  if (scope === "session") return sessionRemovalPlan(state, name);
  if (scope === "global") return globalRemovalPlan(state, name);
  return projectRemovalPlan(state, name);
}
