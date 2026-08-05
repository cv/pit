import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import {
  effectiveRegistry,
  type FunctionState,
  type FunctionStateCommit,
  reconcileFunctionState,
} from "./function-state.js";
import { removeGlobalFunction, saveGlobalFunction } from "./global-function-storage.js";
import { removeProjectFunction, saveProjectFunction } from "./project-function-storage.js";
import { savedFunctionDependents } from "./project-functions.js";
import {
  getNamedFunctionName,
  getGlobalFunctionMetadata,
  getProjectFunctionMetadata,
  getSavedFunctionDependencyGraph,
  type ProjectFunctionMetadata,
  validateTypeScript,
} from "./sandbox.js";
import {
  FUNCTION_ENTRY_TYPE,
  type FunctionActivity,
  type FunctionEntry,
  type FunctionRegistry,
  type FunctionScope,
  functionScopeRegistry,
  validateRegistryCapacity,
  validateSavedFunctionName,
} from "./saved-functions.js";

export interface SavedFunctionExecutionContext {
  cwd: string;
  isProjectTrusted(): boolean;
}

export interface SavedFunctionPreparationRequest {
  source: string;
  input?: unknown;
  saveOnly?: boolean;
  context: SavedFunctionExecutionContext;
}

export interface ProjectFunctionPromotionRequest {
  name: string;
  summary: string;
  context: SavedFunctionExecutionContext;
  activity?: FunctionActivity[];
}

export interface GlobalFunctionPromotionRequest extends ProjectFunctionPromotionRequest {}

export interface ProjectFunctionRemovalRequest {
  name: string;
  context: SavedFunctionExecutionContext;
}

export interface ProjectFunctionStateRemovalRequest {
  cwd: string;
  name: string;
  state: FunctionState;
  commit: FunctionStateCommit;
}

export interface PreparedSavedFunctionExecution {
  source: string;
  input?: unknown;
  name?: string;
  projectMetadata?: ProjectFunctionMetadata;
  registry: FunctionRegistry;
  scopes: Map<string, FunctionScope>;
  globalFunctions: FunctionRegistry;
  projectFunctions: FunctionRegistry;
  sessionFunctions: FunctionRegistry;
  candidateProject?: FunctionRegistry;
  candidateSession?: FunctionRegistry;
}

export interface SavedFunctionServiceDependencies {
  state: FunctionState;
  commit: FunctionStateCommit;
  appendEntry(type: string, entry: FunctionEntry): void;
}

export interface SavedFunctionRemovalPlan {
  name: string;
  scope: FunctionScope;
  directDependents: string[];
  transitiveDependents: string[];
  removalClosure: string[];
  requiresCascade: boolean;
  blocked: boolean;
}

export interface SessionFunctionRemovalOptions {
  cascade?: boolean;
}

function persistentFunctionSource(
  source: string,
  summary: string,
  scope: "global" | "project",
): string {
  const normalizedSummary = summary.trim().replace(/\s+/g, " ").replaceAll("*/", "* /");
  if (!normalizedSummary) {
    throw new Error(`${scope === "global" ? "Global" : "Project"} function summary is required`);
  }
  return `/**\n * ${normalizedSummary}\n *\n * @pit ${scope}\n */\n${source}`;
}

function projectFunctionSource(source: string, summary: string): string {
  return persistentFunctionSource(source, summary, "project");
}

export function removeProjectFunctionFromState(
  request: ProjectFunctionStateRemovalRequest,
): Promise<boolean> {
  const { cwd, name, state, commit } = request;
  return commit(async () => {
    if (state.projectCandidates.has(name)) {
      const dependents = savedFunctionDependents(
        state.projectCandidates,
        state.session,
        state.effective,
        name,
      );
      if (dependents.direct.length > 0 || dependents.transitive.length > 0) {
        const details = [
          dependents.direct.length > 0 ? `direct: ${dependents.direct.join(", ")}` : "",
          dependents.transitive.length > 0 ? `transitive: ${dependents.transitive.join(", ")}` : "",
        ].filter(Boolean);
        throw new Error(
          `Cannot remove project function "${name}"; dependent saved functions remain (${details.join("; ")})`,
        );
      }
    }
    const removed = await removeProjectFunction(cwd, name);
    state.project.delete(name);
    state.projectCandidates.delete(name);
    state.metadata.delete(name);
    state.candidateMetadata.delete(name);
    reconcileFunctionState(state);
    return removed;
  });
}

export class SavedFunctionService {
  readonly #state: FunctionState;
  readonly #commit: FunctionStateCommit;
  readonly #appendEntry: SavedFunctionServiceDependencies["appendEntry"];

  constructor(dependencies: SavedFunctionServiceDependencies) {
    this.#state = dependencies.state;
    this.#commit = dependencies.commit;
    this.#appendEntry = dependencies.appendEntry;
  }

  async promoteToProject(request: ProjectFunctionPromotionRequest): Promise<void> {
    const source = this.#state.session.get(request.name);
    if (source === undefined) {
      throw new Error(`Saved function "${request.name}" was not found`);
    }
    const promotedSource = projectFunctionSource(source, request.summary);
    if (!getProjectFunctionMetadata(promotedSource)) {
      throw new Error(
        `Saved function "${request.name}" must be a top-level function declaration to save it to the project`,
      );
    }
    const prepared = this.prepare({
      source: promotedSource,
      saveOnly: true,
      context: request.context,
    });
    await this.commit(prepared, { cwd: request.context.cwd }, request.activity ?? []);
  }

  removeFromProject(request: ProjectFunctionRemovalRequest): Promise<boolean> {
    if (!request.context.isProjectTrusted()) {
      throw new Error("Project functions require a trusted project");
    }
    if (!this.#state.projectEnabled) {
      throw new Error(
        `Project functions are disabled. Enable them in ${CONFIG_DIR_NAME}/pit.json with {"projectFunctions":{"enabled":true}}`,
      );
    }
    return removeProjectFunctionFromState({
      cwd: request.context.cwd,
      name: request.name,
      state: this.#state,
      commit: this.#commit,
    });
  }

  async promoteToGlobal(request: GlobalFunctionPromotionRequest): Promise<void> {
    if (!this.#state.globalEnabled) {
      throw new Error("Global functions are disabled. Enable them in ~/.pi/agent/pit.json");
    }
    const source = this.#state.session.get(request.name);
    if (source === undefined) {
      throw new Error(`Session function "${request.name}" was not found`);
    }
    const promotedSource = persistentFunctionSource(source, request.summary, "global");
    const metadata = getGlobalFunctionMetadata(promotedSource);
    if (!metadata) {
      throw new Error(
        `Saved function "${request.name}" must be a top-level function declaration to save it globally`,
      );
    }
    const graph = getSavedFunctionDependencyGraph(this.#state.effective);
    const blockers = graph
      .directDependencies(request.name)
      .filter((dependency) => dependency !== request.name && !this.#state.global.has(dependency));
    if (blockers.length > 0) {
      throw new Error(
        `Cannot promote "${request.name}" globally; non-global dependencies remain: ${blockers.join(", ")}`,
      );
    }
    await this.#commit(async () => {
      const currentGlobal = new Map(this.#state.global);
      currentGlobal.set(request.name, promotedSource);
      validateRegistryCapacity(this.#state.effective, request.name, promotedSource);
      validateTypeScript(promotedSource, currentGlobal);
      const currentSession = new Map(this.#state.session);
      currentSession.delete(request.name);
      validateTypeScript(
        promotedSource,
        effectiveRegistry(this.#state.project, currentSession, currentGlobal),
      );
      const replaced = this.#state.global.has(request.name);
      await saveGlobalFunction(request.name, promotedSource, this.#state.global);
      this.#state.global.set(request.name, promotedSource);
      this.#state.globalMetadata.set(request.name, metadata);
      this.#appendEntry(FUNCTION_ENTRY_TYPE, { name: request.name, deleted: true });
      this.#state.session.delete(request.name);
      reconcileFunctionState(this.#state);
      request.activity?.push({ action: "set", name: request.name, replaced, scope: "global" });
    });
  }

  removeFromGlobal(name: string): Promise<boolean> {
    if (!this.#state.globalEnabled) {
      throw new Error("Global functions are disabled. Enable them in ~/.pi/agent/pit.json");
    }
    return this.#commit(async () => {
      const plan = this.planRemoval(name, "global");
      if (plan.blocked) {
        const dependents = [...plan.directDependents, ...plan.transitiveDependents];
        throw new Error(
          `Cannot remove global function "${name}"; dependent saved functions remain: ${dependents.join(", ")}`,
        );
      }
      const removed = await removeGlobalFunction(name);
      this.#state.global.delete(name);
      this.#state.globalMetadata.delete(name);
      reconcileFunctionState(this.#state);
      return removed;
    });
  }

  planRemoval(name: string, requestedScope?: FunctionScope): SavedFunctionRemovalPlan {
    const scope =
      requestedScope ??
      (this.#state.session.has(name)
        ? "session"
        : this.#state.projectCandidates.has(name)
          ? "project"
          : this.#state.global.has(name)
            ? "global"
            : undefined);
    if (scope === undefined) {
      throw new Error(`Saved function "${name}" was not found`);
    }
    if (scope === "session") {
      if (!this.#state.session.has(name)) {
        throw new Error(`Session function "${name}" was not found`);
      }
      const dependents = getSavedFunctionDependencyGraph(this.#state.effective).dependents(name);
      const directDependents = dependents.direct.filter((candidate) =>
        this.#state.session.has(candidate),
      );
      const transitiveDependents = dependents.transitive.filter((candidate) =>
        this.#state.session.has(candidate),
      );
      return {
        name,
        scope,
        directDependents,
        transitiveDependents,
        removalClosure: [name, ...directDependents, ...transitiveDependents].sort((a, b) =>
          a.localeCompare(b),
        ),
        requiresCascade: directDependents.length > 0 || transitiveDependents.length > 0,
        blocked: false,
      };
    }
    if (scope === "global") {
      if (!this.#state.global.has(name)) {
        throw new Error(`Global function "${name}" was not found`);
      }
      const globalDependents = getSavedFunctionDependencyGraph(this.#state.global).dependents(name);
      const effectiveDependents =
        this.#state.effective.get(name) === this.#state.global.get(name)
          ? getSavedFunctionDependencyGraph(this.#state.effective).dependents(name)
          : { direct: [], transitive: [] };
      const directDependents = [
        ...new Set([...globalDependents.direct, ...effectiveDependents.direct]),
      ]
        .filter((candidate) => candidate !== name)
        .sort((a, b) => a.localeCompare(b));
      const transitiveDependents = [
        ...new Set([...globalDependents.transitive, ...effectiveDependents.transitive]),
      ]
        .filter((candidate) => candidate !== name && !directDependents.includes(candidate))
        .sort((a, b) => a.localeCompare(b));
      return {
        name,
        scope,
        directDependents,
        transitiveDependents,
        removalClosure: [name],
        requiresCascade: false,
        blocked: directDependents.length > 0 || transitiveDependents.length > 0,
      };
    }

    if (!this.#state.projectCandidates.has(name)) {
      throw new Error(`Project function "${name}" was not found`);
    }
    const dependents = savedFunctionDependents(
      this.#state.projectCandidates,
      this.#state.session,
      this.#state.effective,
      name,
    );
    return {
      name,
      scope,
      directDependents: dependents.direct,
      transitiveDependents: dependents.transitive,
      removalClosure: [name],
      requiresCascade: false,
      blocked: dependents.direct.length > 0 || dependents.transitive.length > 0,
    };
  }

  planSessionRemoval(name: string): string[] {
    return this.planRemoval(name, "session").removalClosure;
  }

  removeSession(name: string, options: SessionFunctionRemovalOptions = {}): Promise<string[]> {
    return this.#commit(() => {
      const plan = this.planRemoval(name, "session");
      if (plan.requiresCascade && options.cascade !== true) {
        const dependents = [...plan.directDependents, ...plan.transitiveDependents];
        throw new Error(
          `Cannot remove session function "${name}" without explicit cascade (dependents: ${dependents.join(", ")}); pass { cascade: true }`,
        );
      }
      for (const removedName of plan.removalClosure) {
        this.#appendEntry(FUNCTION_ENTRY_TYPE, { name: removedName, deleted: true });
        this.#state.session.delete(removedName);
      }
      reconcileFunctionState(this.#state);
      return plan.removalClosure;
    });
  }

  prepare(request: SavedFunctionPreparationRequest): PreparedSavedFunctionExecution {
    const name = getNamedFunctionName(request.source);
    const projectMetadata = getProjectFunctionMetadata(request.source);
    if (request.saveOnly && name === undefined) {
      throw new Error("saveOnly requires a named top-level function");
    }
    if (request.saveOnly && request.input !== undefined) {
      throw new Error("saveOnly does not accept top-level params");
    }

    let registry = this.#state.effective;
    let candidateProject: FunctionRegistry | undefined;
    let candidateSession: FunctionRegistry | undefined;
    if (name) {
      validateSavedFunctionName(name);
      if (projectMetadata) {
        if (!request.context.isProjectTrusted()) {
          throw new Error("Project functions require a trusted project");
        }
        if (!this.#state.projectEnabled) {
          throw new Error(
            `Project functions are disabled. Enable them in ${CONFIG_DIR_NAME}/pit.json with {"projectFunctions":{"enabled":true}}`,
          );
        }
        validateRegistryCapacity(this.#state.effective, name, request.source);
        candidateProject = new Map(this.#state.project);
        candidateProject.set(name, request.source);
        validateTypeScript(
          request.source,
          new Map([...this.#state.global, ...candidateProject]),
          request.input,
        );
        candidateSession = new Map(this.#state.session);
        candidateSession.delete(name);
        registry = effectiveRegistry(candidateProject, candidateSession, this.#state.global);
        validateTypeScript(request.source, registry, request.input);
      } else {
        validateRegistryCapacity(this.#state.effective, name, request.source);
        candidateSession = new Map(this.#state.session);
        candidateSession.set(name, request.source);
        registry = effectiveRegistry(this.#state.project, candidateSession, this.#state.global);
        validateTypeScript(request.source, registry, request.input);
      }
    }
    const scopes = functionScopeRegistry(
      registry,
      this.#state.global,
      candidateProject ?? this.#state.project,
      candidateSession ?? this.#state.session,
    );
    return {
      source: request.source,
      ...(request.input === undefined ? {} : { input: request.input }),
      ...(name ? { name } : {}),
      ...(projectMetadata ? { projectMetadata } : {}),
      registry,
      scopes,
      globalFunctions: this.#state.global,
      projectFunctions: candidateProject ?? this.#state.project,
      sessionFunctions: candidateSession ?? this.#state.session,
      ...(candidateProject ? { candidateProject } : {}),
      ...(candidateSession ? { candidateSession } : {}),
    };
  }

  async commit(
    prepared: PreparedSavedFunctionExecution,
    context: Pick<SavedFunctionExecutionContext, "cwd">,
    activity: FunctionActivity[],
  ): Promise<void> {
    const { name, projectMetadata, candidateProject, candidateSession, source, input } = prepared;
    if (!(name && candidateSession)) {
      return;
    }
    if (projectMetadata && candidateProject) {
      await this.#commit(async () => {
        validateRegistryCapacity(this.#state.effective, name, source);
        const currentProject = new Map(this.#state.project);
        currentProject.set(name, source);
        validateTypeScript(source, new Map([...this.#state.global, ...currentProject]), input);
        const currentSession = new Map(this.#state.session);
        currentSession.delete(name);
        validateTypeScript(
          source,
          effectiveRegistry(currentProject, currentSession, this.#state.global),
          input,
        );

        const replaced = this.#state.project.has(name);
        await saveProjectFunction(context.cwd, name, source, {
          registry: this.#state.projectCandidates,
          global: this.#state.global,
        });
        this.#state.project.set(name, source);
        this.#state.metadata.set(name, projectMetadata);
        this.#state.candidateMetadata.set(name, projectMetadata);
        if (this.#state.session.has(name)) {
          this.#appendEntry(FUNCTION_ENTRY_TYPE, { name, deleted: true });
        }
        this.#state.session.delete(name);
        reconcileFunctionState(this.#state);
        activity.push({ action: "set", name, replaced, scope: "project" });
      });
      return;
    }

    await this.#commit(() => {
      validateRegistryCapacity(this.#state.effective, name, source);
      const currentSession = new Map(this.#state.session);
      currentSession.set(name, source);
      validateTypeScript(
        source,
        effectiveRegistry(this.#state.project, currentSession, this.#state.global),
        input,
      );
      const replaced = this.#state.session.has(name);
      this.#appendEntry(FUNCTION_ENTRY_TYPE, { name, source });
      this.#state.session.set(name, source);
      reconcileFunctionState(this.#state);
      activity.push({ action: "set", name, replaced });
    });
  }
}
