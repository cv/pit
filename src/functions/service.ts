import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { validateTypeScript } from "../sandbox/validation.js";
import { getSavedFunctionDependencyGraph } from "./graph.js";
import {
  prepareSavedFunctionExecution,
  type PreparedSavedFunctionExecution,
  type SavedFunctionExecutionContext,
  type SavedFunctionPreparationRequest,
} from "./preparation.js";
import { planSavedFunctionRemoval, type SavedFunctionRemovalPlan } from "./removal.js";
import { getPersistentFunctionMetadata } from "./source.js";
import { assertFunctionsAvailable } from "./storage/validation.js";
export type { PreparedSavedFunctionExecution } from "./preparation.js";
import {
  effectiveRegistry,
  stateFunctionEnvironment,
  type FunctionState,
  type FunctionStateCommit,
  reconcileFunctionState,
} from "./state.js";
import { removeProjectFunction, saveProjectFunction } from "./storage/project.js";
import { removeUserFunction, saveUserFunction } from "./storage/user.js";
export type { SavedFunctionRemovalPlan } from "./removal.js";
import {
  FUNCTION_ENTRY_TYPE,
  type FunctionActivity,
  type FunctionEntry,
  type FunctionScope,
  validateRegistryCapacity,
  validateFunctionRegistryIdentifiers,
} from "./core.js";

export interface PersistentFunctionPromotionRequest {
  name: string;
  summary: string;
  context: SavedFunctionExecutionContext;
  activity?: FunctionActivity[];
}

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

export interface SavedFunctionServiceDependencies {
  state: FunctionState;
  commit: FunctionStateCommit;
  appendEntry(type: string, entry: FunctionEntry): void;
}

export interface SessionFunctionRemovalOptions {
  cascade?: boolean;
}

function persistentFunctionSource(
  source: string,
  summary: string,
  scope: "user" | "project",
): string {
  const normalizedSummary = summary.trim().replace(/\s+/g, " ").replaceAll("*/", "* /");
  if (!normalizedSummary) {
    throw new Error(`${scope === "user" ? "User" : "Project"} function summary is required`);
  }
  return `/** ${normalizedSummary} */\n${source}`;
}

function projectFunctionSource(source: string, summary: string): string {
  return persistentFunctionSource(source, summary, "project");
}

export function removeProjectFunctionFromState(
  request: ProjectFunctionStateRemovalRequest,
): Promise<boolean> {
  const { cwd, name, state, commit } = request;
  return commit(async () => {
    if (state.projectCandidates.has(name) || state.invalidProject.has(name)) {
      const plan = planSavedFunctionRemoval(state, name, "project");
      if (plan.blocked) {
        const details = [
          plan.directDependents.length ? `direct: ${plan.directDependents.join(", ")}` : "",
          plan.transitiveDependents.length
            ? `transitive: ${plan.transitiveDependents.join(", ")}`
            : "",
        ].filter(Boolean);
        throw new Error(
          `Cannot remove project function "${name}"; dependent saved functions remain (${details.join("; ")})`,
        );
      }
    }
    const removed = await removeProjectFunction(cwd, name);
    state.invalidProject.delete(name);
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

  async promoteToProject(request: PersistentFunctionPromotionRequest): Promise<void> {
    const source = this.#state.session.get(request.name);
    if (source === undefined) {
      throw new Error(`Saved function "${request.name}" was not found`);
    }
    const promotedSource = projectFunctionSource(source, request.summary);
    if (!getPersistentFunctionMetadata(promotedSource)) {
      throw new Error(
        `Saved function "${request.name}" must be a top-level function declaration to save it to the project`,
      );
    }
    const prepared = this.prepare({
      source: promotedSource,
      functionId: request.name,
      saveOnly: true,

      project: true,
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

  async promoteToUser(request: PersistentFunctionPromotionRequest): Promise<void> {
    const source = this.#state.session.get(request.name);
    if (source === undefined) {
      throw new Error(`Session function "${request.name}" was not found`);
    }
    const promotedSource = persistentFunctionSource(source, request.summary, "user");
    const metadata = getPersistentFunctionMetadata(promotedSource, request.name);
    if (!metadata) {
      throw new Error(
        `Saved function "${request.name}" must be a top-level function declaration to save it to user scope`,
      );
    }
    const graph = getSavedFunctionDependencyGraph(this.#state.effective);
    const blockers = graph
      .directDependencies(request.name)
      .filter((dependency) => dependency !== request.name && !this.#state.user.has(dependency));
    if (blockers.length > 0) {
      throw new Error(
        `Cannot promote "${request.name}" to user scope; non-user dependencies remain: ${blockers.join(", ")}`,
      );
    }
    await this.#commit(async () => {
      const currentUser = new Map(this.#state.user);
      currentUser.set(request.name, promotedSource);
      validateFunctionRegistryIdentifiers(currentUser.keys());
      validateRegistryCapacity(this.#state.effective, request.name, promotedSource);
      assertFunctionsAvailable(promotedSource, currentUser, this.#state.invalidUser);
      validateTypeScript(promotedSource, currentUser, undefined, {
        environment: { userFunctions: currentUser },
        definition: { id: request.name, layer: "user" },
      });
      const currentSession = new Map(this.#state.session);
      currentSession.delete(request.name);
      validateTypeScript(
        promotedSource,
        effectiveRegistry(this.#state.project, currentSession, currentUser),
        undefined,
        {
          environment: stateFunctionEnvironment(this.#state, {
            userFunctions: currentUser,
            sessionFunctions: currentSession,
          }),
          definition: { id: request.name, layer: "user" },
        },
      );
      const replaced = this.#state.user.has(request.name);
      await saveUserFunction(request.name, promotedSource, this.#state.user);
      this.#state.user.set(request.name, promotedSource);
      this.#state.userMetadata.set(request.name, metadata);
      this.#state.invalidUser.delete(request.name);
      this.#appendEntry(FUNCTION_ENTRY_TYPE, { name: request.name, deleted: true });
      this.#state.session.delete(request.name);
      reconcileFunctionState(this.#state);
      request.activity?.push({ action: "set", name: request.name, replaced, scope: "user" });
    });
  }

  removeFromUser(name: string): Promise<boolean> {
    return this.#commit(async () => {
      const plan = this.planRemoval(name, "user");
      if (plan.blocked) {
        const dependents = [...plan.directDependents, ...plan.transitiveDependents];
        throw new Error(
          `Cannot remove user function "${name}"; dependent saved functions remain: ${dependents.join(", ")}`,
        );
      }
      const removed = await removeUserFunction(name);
      this.#state.invalidUser.delete(name);
      this.#state.user.delete(name);
      this.#state.userMetadata.delete(name);
      reconcileFunctionState(this.#state);
      return removed;
    });
  }

  planRemoval(name: string, requestedScope?: FunctionScope): SavedFunctionRemovalPlan {
    return planSavedFunctionRemoval(this.#state, name, requestedScope);
  }

  removeSession(name: string, options: SessionFunctionRemovalOptions = {}): Promise<string[]> {
    return this.#commit(() => {
      const plan = this.planRemoval(name, "session");
      if (plan.blocked)
        throw new Error(`Cannot remove session function "${name}"; persistent dependents remain`);
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
    return prepareSavedFunctionExecution(this.#state, request);
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
        validateFunctionRegistryIdentifiers(
          effectiveRegistry(currentProject, this.#state.session, this.#state.user).keys(),
        );
        validateTypeScript(source, new Map(), input, {
          environment: { userFunctions: this.#state.user, projectFunctions: currentProject },
          definition: { id: name, layer: "project" },
        });
        const currentSession = new Map(this.#state.session);
        currentSession.delete(name);
        validateTypeScript(
          source,
          effectiveRegistry(currentProject, currentSession, this.#state.user),
          input,
          {
            environment: stateFunctionEnvironment(this.#state, {
              projectFunctions: currentProject,
              sessionFunctions: currentSession,
            }),
            definition: { id: name, layer: "project" },
          },
        );

        const replaced = this.#state.project.has(name);
        await saveProjectFunction(context.cwd, name, source, {
          registry: this.#state.projectCandidates,
          user: this.#state.user,
        });
        this.#state.invalidProject.delete(name);
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
      validateFunctionRegistryIdentifiers(
        effectiveRegistry(this.#state.project, currentSession, this.#state.user).keys(),
      );
      validateTypeScript(
        source,
        effectiveRegistry(this.#state.project, currentSession, this.#state.user),
        input,
        {
          environment: stateFunctionEnvironment(this.#state, { sessionFunctions: currentSession }),
          definition: { id: name, layer: "session" },
        },
      );
      const replaced = this.#state.session.has(name);
      this.#appendEntry(FUNCTION_ENTRY_TYPE, { name, source });
      this.#state.session.set(name, source);
      reconcileFunctionState(this.#state);
      activity.push({ action: "set", name, replaced });
    });
  }
}
