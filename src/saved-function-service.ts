import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import {
  effectiveRegistry,
  type FunctionState,
  type FunctionStateCommit,
  reconcileFunctionState,
} from "./function-state.js";
import { saveProjectFunction } from "./project-functions.js";
import {
  getNamedFunctionName,
  getProjectFunctionMetadata,
  type ProjectFunctionMetadata,
  validateTypeScript,
} from "./sandbox.js";
import {
  FUNCTION_ENTRY_TYPE,
  type FunctionActivity,
  type FunctionEntry,
  type FunctionRegistry,
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
}

export interface PreparedSavedFunctionExecution {
  source: string;
  input?: unknown;
  name?: string;
  projectMetadata?: ProjectFunctionMetadata;
  registry: FunctionRegistry;
  scopes: Map<string, "project" | "session">;
  candidateProject?: FunctionRegistry;
  candidateSession?: FunctionRegistry;
}

export interface SavedFunctionServiceDependencies {
  state: FunctionState;
  commit: FunctionStateCommit;
  appendEntry(type: string, entry: FunctionEntry): void;
}

function projectFunctionSource(source: string, summary: string): string {
  const normalizedSummary = summary.trim().replace(/\s+/g, " ").replaceAll("*/", "* /");
  if (!normalizedSummary) {
    throw new Error("Project function summary is required");
  }
  return `/**\n * ${normalizedSummary}\n *\n * @pit project\n */\n${source}`;
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
    await this.commit(prepared, { cwd: request.context.cwd }, []);
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
        validateTypeScript(request.source, candidateProject, request.input);
        candidateSession = new Map(this.#state.session);
        candidateSession.delete(name);
        registry = effectiveRegistry(candidateProject, candidateSession);
        validateTypeScript(request.source, registry, request.input);
      } else {
        validateRegistryCapacity(this.#state.effective, name, request.source);
        candidateSession = new Map(this.#state.session);
        candidateSession.set(name, request.source);
        registry = effectiveRegistry(this.#state.project, candidateSession);
        validateTypeScript(request.source, registry, request.input);
      }
    }
    const scopes = functionScopeRegistry(registry, candidateSession ?? this.#state.session);
    return {
      source: request.source,
      ...(request.input === undefined ? {} : { input: request.input }),
      ...(name ? { name } : {}),
      ...(projectMetadata ? { projectMetadata } : {}),
      registry,
      scopes,
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
        validateTypeScript(source, currentProject, input);
        const currentSession = new Map(this.#state.session);
        currentSession.delete(name);
        validateTypeScript(source, effectiveRegistry(currentProject, currentSession), input);

        const replaced = this.#state.project.has(name);
        await saveProjectFunction(context.cwd, name, source, this.#state.projectCandidates);
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
      validateTypeScript(source, effectiveRegistry(this.#state.project, currentSession), input);
      const replaced = this.#state.session.has(name);
      this.#appendEntry(FUNCTION_ENTRY_TYPE, { name, source });
      this.#state.session.set(name, source);
      reconcileFunctionState(this.#state);
      activity.push({ action: "set", name, replaced });
    });
  }
}
