import type { FunctionRegistry } from "./core.js";
import type { FunctionEnvironment } from "./environment.js";
import { reconcileProjectFunctionsForSession } from "./persistent-functions.js";
import type { PersistentFunctionMetadataRegistry } from "./source.js";

export interface FunctionState {
  projectEnabled: boolean;
  user: FunctionRegistry;
  invalidUser: Map<string, string>;
  invalidProject: Map<string, string>;
  project: FunctionRegistry;
  projectCandidates: FunctionRegistry;
  session: FunctionRegistry;
  effective: FunctionRegistry;
  userMetadata: PersistentFunctionMetadataRegistry;
  metadata: PersistentFunctionMetadataRegistry;
  candidateMetadata: PersistentFunctionMetadataRegistry;
  sessionRunCounts: Map<string, number>;
  promotionSuggested: Set<string>;
}

export type FunctionStateCommit = <T>(operation: () => Promise<T> | T) => Promise<T>;

export function createFunctionState(): FunctionState {
  return {
    projectEnabled: false,
    user: new Map(),
    invalidUser: new Map(),
    invalidProject: new Map(),
    project: new Map(),
    projectCandidates: new Map(),
    session: new Map(),
    effective: new Map(),
    userMetadata: new Map(),
    metadata: new Map(),
    candidateMetadata: new Map(),
    sessionRunCounts: new Map(),
    promotionSuggested: new Set(),
  };
}

export function createFunctionStateCommitQueue(): FunctionStateCommit {
  let tail = Promise.resolve();
  return <T>(operation: () => Promise<T> | T): Promise<T> => {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

export function resetFunctionUsage(state: FunctionState): void {
  state.sessionRunCounts.clear();
  state.promotionSuggested.clear();
}

export function refreshEffectiveFunctions(state: FunctionState): void {
  state.effective.clear();
  for (const [name, source] of state.user) {
    state.effective.set(name, source);
  }
  for (const [name, source] of state.project) {
    state.effective.set(name, source);
  }
  for (const [name, source] of state.session) {
    state.effective.set(name, source);
  }
}

export function reconcileFunctionState(state: FunctionState): string[] {
  const errors = reconcileProjectFunctionsForSession({
    user: state.user,
    candidates: state.projectCandidates,
    candidateMetadata: state.candidateMetadata,
    session: state.session,
    registry: state.project,
    metadata: state.metadata,
  });
  refreshEffectiveFunctions(state);
  return errors;
}

export function effectiveRegistry(
  project: ReadonlyMap<string, string>,
  session: ReadonlyMap<string, string>,
  user: ReadonlyMap<string, string> = new Map(),
): FunctionRegistry {
  return new Map([...user, ...project, ...session]);
}

export function stateFunctionEnvironment(
  state: FunctionState,
  overrides: FunctionEnvironment = {},
): FunctionEnvironment {
  return {
    userFunctions: state.user,
    projectFunctions: state.project,
    sessionFunctions: state.session,
    invalidDefinitions: new Map([...state.invalidUser, ...state.invalidProject]),
    ...overrides,
  };
}
