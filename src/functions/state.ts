import type { FunctionRegistry } from "./core.js";
import { reconcileProjectFunctionsForSession } from "./project-functions.js";
import type { GlobalFunctionMetadataRegistry } from "./storage/global.js";
import type { ProjectFunctionMetadataRegistry } from "./storage/project.js";

export interface FunctionState {
  globalEnabled: boolean;
  projectEnabled: boolean;
  global: FunctionRegistry;
  project: FunctionRegistry;
  projectCandidates: FunctionRegistry;
  session: FunctionRegistry;
  effective: FunctionRegistry;
  globalMetadata: GlobalFunctionMetadataRegistry;
  metadata: ProjectFunctionMetadataRegistry;
  candidateMetadata: ProjectFunctionMetadataRegistry;
  sessionRunCounts: Map<string, number>;
  promotionSuggested: Set<string>;
}

export type FunctionStateCommit = <T>(operation: () => Promise<T> | T) => Promise<T>;

export function createFunctionState(): FunctionState {
  return {
    globalEnabled: false,
    projectEnabled: false,
    global: new Map(),
    project: new Map(),
    projectCandidates: new Map(),
    session: new Map(),
    effective: new Map(),
    globalMetadata: new Map(),
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
  for (const [name, source] of state.global) {
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
    global: state.global,
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
  global: ReadonlyMap<string, string> = new Map(),
): FunctionRegistry {
  return new Map([...global, ...project, ...session]);
}
