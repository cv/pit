import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { validateTypeScript } from "../sandbox/validation.js";
import {
  type FunctionRegistry,
  type FunctionScope,
  functionScopeRegistry,
  validateRegistryCapacity,
  sessionFunctionId,
  validateFunctionRegistryIdentifiers,
} from "./core.js";
import { getPersistentFunctionMetadata } from "./source.js";
import { effectiveRegistry, type FunctionState } from "./state.js";
import { assertFunctionsAvailable } from "./storage/validation.js";

export interface SavedFunctionExecutionContext {
  cwd: string;
  isProjectTrusted(): boolean;
}

export interface SavedFunctionPreparationRequest {
  source: string;
  functionId?: string;
  input?: unknown;
  saveOnly?: boolean;
  project?: boolean;
  context: SavedFunctionExecutionContext;
}

export interface PreparedSavedFunctionExecution {
  source: string;
  input?: unknown;
  name?: string;
  projectMetadata?: NonNullable<ReturnType<typeof getPersistentFunctionMetadata>>;
  registry: FunctionRegistry;
  scopes: Map<string, FunctionScope>;
  userFunctions: FunctionRegistry;
  projectFunctions: FunctionRegistry;
  sessionFunctions: FunctionRegistry;
  candidateProject?: FunctionRegistry;
  candidateSession?: FunctionRegistry;
}

interface PreparedRegistries {
  registry: FunctionRegistry;
  candidateProject?: FunctionRegistry;
  candidateSession?: FunctionRegistry;
}

function prepareProjectFunction(
  state: FunctionState,
  request: SavedFunctionPreparationRequest,
  name: string,
): PreparedRegistries {
  if (!request.context.isProjectTrusted()) {
    throw new Error("Project functions require a trusted project");
  }
  if (!state.projectEnabled) {
    throw new Error(
      `Project functions are disabled. Enable them in ${CONFIG_DIR_NAME}/pit.json with {"projectFunctions":{"enabled":true}}`,
    );
  }
  validateRegistryCapacity(state.effective, name, request.source);
  const candidateProject = new Map(state.project);
  candidateProject.set(name, request.source);
  validateTypeScript(request.source, new Map([...state.user, ...candidateProject]), request.input);
  const candidateSession = new Map(state.session);
  candidateSession.delete(name);
  const registry = effectiveRegistry(candidateProject, candidateSession, state.user);
  validateFunctionRegistryIdentifiers(registry.keys());
  validateTypeScript(request.source, registry, request.input);
  return { registry, candidateProject, candidateSession };
}

function prepareSessionFunction(
  state: FunctionState,
  request: SavedFunctionPreparationRequest,
  name: string,
): PreparedRegistries {
  validateRegistryCapacity(state.effective, name, request.source);
  const candidateSession = new Map(state.session);
  candidateSession.set(name, request.source);
  const registry = effectiveRegistry(state.project, candidateSession, state.user);
  validateTypeScript(request.source, registry, request.input);
  return { registry, candidateSession };
}

export function prepareSavedFunctionExecution(
  state: FunctionState,
  request: SavedFunctionPreparationRequest,
): PreparedSavedFunctionExecution {
  const name = sessionFunctionId(request.source, request.functionId);
  const projectMetadata = request.project
    ? getPersistentFunctionMetadata(request.source, name)
    : undefined;
  if (request.project && !projectMetadata) {
    throw new Error(
      `Saved function "${name ?? ""}" must be a top-level function declaration to save it to the project`,
    );
  }
  if (request.saveOnly && name === undefined) {
    throw new Error("saveOnly requires a named top-level function");
  }
  if (request.saveOnly && request.input !== undefined) {
    throw new Error("saveOnly does not accept top-level params");
  }

  const prepared = !name
    ? { registry: state.effective }
    : projectMetadata
      ? prepareProjectFunction(state, request, name)
      : prepareSessionFunction(state, request, name);
  assertFunctionsAvailable(
    request.source,
    prepared.registry,
    new Map([...state.invalidUser, ...state.invalidProject]),
  );
  const projectFunctions = prepared.candidateProject ?? state.project;
  const sessionFunctions = prepared.candidateSession ?? state.session;
  return {
    source: request.source,
    ...(request.input === undefined ? {} : { input: request.input }),
    ...(name ? { name } : {}),
    ...(projectMetadata ? { projectMetadata } : {}),
    registry: prepared.registry,
    scopes: functionScopeRegistry(
      prepared.registry,
      state.user,
      projectFunctions,
      sessionFunctions,
    ),
    userFunctions: state.user,
    projectFunctions,
    sessionFunctions,
    ...(prepared.candidateProject ? { candidateProject: prepared.candidateProject } : {}),
    ...(prepared.candidateSession ? { candidateSession: prepared.candidateSession } : {}),
  };
}
