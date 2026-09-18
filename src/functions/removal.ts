import { validateTypeScript } from "../sandbox/validation.js";
import type { FunctionScope } from "./core.js";
import { getFunctionDependencies } from "./dependencies.js";
import { functionRegistry } from "./environment.js";
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
  requestedScope?: Exclude<FunctionScope, "global">,
): Exclude<FunctionScope, "global"> {
  const scope =
    requestedScope ??
    (state.session.has(name)
      ? "session"
      : state.projectCandidates.has(name) || state.invalidProject.has(name)
        ? "project"
        : state.user.has(name) || state.invalidUser.has(name)
          ? "user"
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

function userRemovalPlan(state: FunctionState, name: string): SavedFunctionRemovalPlan {
  if (!state.user.has(name) && !state.invalidUser.has(name)) {
    throw new Error(`User function "${name}" was not found`);
  }
  const userDependents = getSavedFunctionDependencyGraph(state.user).dependents(name);
  const effectiveDependents =
    state.effective.get(name) === state.user.get(name)
      ? getSavedFunctionDependencyGraph(state.effective).dependents(name)
      : { direct: [], transitive: [] };
  const directDependents = [...new Set([...userDependents.direct, ...effectiveDependents.direct])]
    .filter((candidate) => candidate !== name)
    .sort((a, b) => a.localeCompare(b));
  const transitiveDependents = [
    ...new Set([...userDependents.transitive, ...effectiveDependents.transitive]),
  ]
    .filter((candidate) => candidate !== name && !directDependents.includes(candidate))
    .sort((a, b) => a.localeCompare(b));
  return {
    name,
    scope: "user",
    directDependents,
    transitiveDependents,
    removalClosure: [name],
    requiresCascade: false,
    blocked: directDependents.length > 0 || transitiveDependents.length > 0,
  };
}

function projectRemovalPlan(state: FunctionState, name: string): SavedFunctionRemovalPlan {
  if (!state.projectCandidates.has(name) && !state.invalidProject.has(name)) {
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

function overrideRemovalPlan(
  state: FunctionState,
  name: string,
  scope: Exclude<FunctionScope, "global">,
): SavedFunctionRemovalPlan | undefined {
  const original = functionRegistry({
    userFunctions: state.user,
    projectFunctions: state.project,
    sessionFunctions: state.session,
  });
  if (!original.get(scope, name) || original.chain(name).length < 2) return;
  const userFunctions = new Map(state.user);
  const projectFunctions = new Map(state.project);
  const sessionFunctions = new Map(state.session);
  ({ user: userFunctions, project: projectFunctions, session: sessionFunctions })[scope].delete(
    name,
  );
  const environment = { userFunctions, projectFunctions, sessionFunctions };
  const remaining = functionRegistry(environment)
    .definitions()
    .filter((definition) => definition.kind === "source");
  const affected = new Set([name]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const definition of remaining) {
      if (
        !affected.has(definition.id) &&
        getFunctionDependencies(definition.source).dependencies.some((dependency) =>
          affected.has(dependency.id),
        )
      ) {
        affected.add(definition.id);
        changed = true;
      }
    }
  }
  const failures = remaining.filter((definition) => {
    if (!affected.has(definition.id)) return false;
    try {
      validateTypeScript(definition.source, new Map(), undefined, {
        environment,
        definition: { id: definition.id, layer: definition.layer },
        checkAll: false,
      });
      return false;
    } catch {
      return true;
    }
  });
  const dependents = [...new Set(failures.map((definition) => definition.id))].sort();
  const blocked = failures.some(
    (definition) => scope !== "session" || definition.layer !== "session",
  );
  return {
    name,
    scope,
    directDependents: dependents,
    transitiveDependents: [],
    removalClosure: scope === "session" ? [...new Set([name, ...dependents])].sort() : [name],
    requiresCascade: scope === "session" && dependents.length > 0,
    blocked,
  };
}

export function planSavedFunctionRemoval(
  state: FunctionState,
  name: string,
  requestedScope?: FunctionScope,
): SavedFunctionRemovalPlan {
  if (requestedScope === "global") throw new Error("Global functions are immutable");
  const scope = selectedScope(state, name, requestedScope);
  const layered = overrideRemovalPlan(state, name, scope);
  if (layered) return layered;
  if (scope === "session") return sessionRemovalPlan(state, name);
  if (scope === "user") return userRemovalPlan(state, name);
  return projectRemovalPlan(state, name);
}
