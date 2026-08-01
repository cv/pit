import type { ProjectFunctionMetadataRegistry } from "./project-functions.js";
import { reconcileProjectFunctionsForSession } from "./project-functions.js";
import type { FunctionRegistry } from "./saved-functions.js";

export interface FunctionState {
  projectEnabled: boolean;
  project: FunctionRegistry;
  projectCandidates: FunctionRegistry;
  session: FunctionRegistry;
  effective: FunctionRegistry;
  metadata: ProjectFunctionMetadataRegistry;
  candidateMetadata: ProjectFunctionMetadataRegistry;
}

export type FunctionStateCommit = <T>(operation: () => Promise<T> | T) => Promise<T>;

export function createFunctionState(): FunctionState {
  return {
    projectEnabled: false,
    project: new Map(),
    projectCandidates: new Map(),
    session: new Map(),
    effective: new Map(),
    metadata: new Map(),
    candidateMetadata: new Map(),
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

export function refreshEffectiveFunctions(state: FunctionState): void {
  state.effective.clear();
  for (const [name, source] of state.project) {
    state.effective.set(name, source);
  }
  for (const [name, source] of state.session) {
    state.effective.set(name, source);
  }
}

export function reconcileFunctionState(state: FunctionState): string[] {
  const errors = reconcileProjectFunctionsForSession({
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
): FunctionRegistry {
  return new Map([...project, ...session]);
}
