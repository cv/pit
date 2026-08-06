import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { CAPABILITY_METHODS } from "./capability-registry.js";
import { recordValue as record, stringValue as string } from "./cli.js";
import type { FunctionState, FunctionStateCommit } from "./function-state.js";
import {
  globalFunctionConfigPath,
  globalFunctionDirectory,
  globalFunctionPath,
} from "./global-function-storage.js";
import { getSavedFunctionCallSignature, getSavedFunctionDependencyGraph } from "./sandbox.js";
import { removeProjectFunctionFromState, SavedFunctionService } from "./saved-function-service.js";
import type { FunctionActivity, FunctionScope } from "./saved-functions.js";
import { validateSavedFunctionName } from "./saved-functions.js";

type FunctionMethod = (typeof CAPABILITY_METHODS)["functions"][number];
type FunctionMethodHandler = (args: unknown[]) => unknown | Promise<unknown>;

interface FunctionCapabilityServices {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  functionState: FunctionState;
  commitFunctionState: FunctionStateCommit;
  activity: FunctionActivity[];
}

function requiredName(args: unknown[]): string {
  const name = string(args[0], "function name");
  validateSavedFunctionName(name);
  return name;
}

function functionScope(value: unknown): FunctionScope | undefined {
  const scope = value === undefined ? undefined : string(value, "function scope");
  if (scope !== undefined && scope !== "global" && scope !== "project" && scope !== "session") {
    throw new Error('function scope must be "global", "project", or "session"');
  }
  return scope;
}

function removalCascade(value: unknown): boolean {
  if (value === undefined) {
    return false;
  }
  const options = record(value, "removeSession options");
  const unknown = Object.keys(options).filter((key) => key !== "cascade");
  if (unknown.length > 0) {
    throw new Error(`removeSession options contain unknown fields: ${unknown.join(", ")}`);
  }
  if (options.cascade !== undefined && typeof options.cascade !== "boolean") {
    throw new TypeError("removeSession options.cascade must be a boolean");
  }
  return options.cascade === true;
}

function promotionTarget(value: unknown): "global" | "project" {
  if (value === undefined) {
    return "project";
  }
  const options = record(value, "promotion options");
  const unknown = Object.keys(options).filter((key) => key !== "to");
  if (unknown.length > 0) {
    throw new Error(`promotion options contain unknown fields: ${unknown.join(", ")}`);
  }
  const target = options.to === undefined ? "project" : string(options.to, "promotion options.to");
  if (target !== "global" && target !== "project") {
    throw new Error('promotion options.to must be "global" or "project"');
  }
  return target;
}

function sourceForScope(
  state: FunctionState,
  name: string,
  scope: FunctionScope,
): string | undefined {
  return scope === "session"
    ? state.session.get(name)
    : scope === "project"
      ? state.project.get(name)
      : state.global.get(name);
}

function effectiveScope(state: FunctionState, name: string): FunctionScope {
  return state.session.has(name) ? "session" : state.project.has(name) ? "project" : "global";
}

interface SavedMetadataInput {
  functionState: FunctionState;
  service: SavedFunctionService;
  name: string;
  source: string;
  requestedScope?: FunctionScope;
}

function savedMetadata({
  functionState,
  service,
  name,
  source,
  requestedScope,
}: SavedMetadataInput) {
  const scope = requestedScope ?? effectiveScope(functionState, name);
  const graph = getSavedFunctionDependencyGraph(
    scope === "session"
      ? functionState.effective
      : scope === "project"
        ? new Map([...functionState.global, ...functionState.project])
        : functionState.global,
  );
  const plan = service.planRemoval(name, scope);
  return {
    name,
    scope,
    /* v8 ignore next -- saved registries contain validated named function declarations. */
    signature: getSavedFunctionCallSignature(source) ?? `${name}()`,
    lines: source.split("\n").length,
    bytes: Buffer.byteLength(source),
    directDependencies: [...graph.directDependencies(name)],
    directDependents: plan.directDependents,
    overridesProject: scope === "session" && functionState.project.has(name),
    overridesGlobal: (scope === "session" || scope === "project") && functionState.global.has(name),
  };
}

type PersistentFunctionMethod =
  | "list"
  | "get"
  | "remove"
  | "listGlobal"
  | "getGlobal"
  | "removeGlobal";

interface PersistentFunctionHandlerServices {
  ctx: ExtensionContext;
  functionState: FunctionState;
  commitFunctionState: FunctionStateCommit;
  activity: FunctionActivity[];
  service: SavedFunctionService;
  requireProjectAccess(): void;
  requireGlobalAccess(): void;
}

function createPersistentFunctionHandlers({
  ctx,
  functionState,
  commitFunctionState,
  activity,
  service,
  requireProjectAccess,
  requireGlobalAccess,
}: PersistentFunctionHandlerServices): Pick<
  Record<FunctionMethod, FunctionMethodHandler>,
  PersistentFunctionMethod
> {
  return {
    list: () => {
      requireProjectAccess();
      return [...functionState.metadata.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
    get: (args) => {
      requireProjectAccess();
      const name = requiredName(args);
      const source = functionState.project.get(name);
      if (!source) {
        throw new Error(`Project function "${name}" is unavailable`);
      }
      return { ...functionState.metadata.get(name), source };
    },
    remove: (args) => {
      requireProjectAccess();
      const name = requiredName(args);
      return removeProjectFunctionFromState({
        cwd: ctx.cwd,
        name,
        state: functionState,
        commit: commitFunctionState,
      }).then((removed) => {
        if (removed) {
          activity.push({ action: "remove", name, scope: "project" });
        }
        return { name, removed };
      });
    },
    listGlobal: () => {
      requireGlobalAccess();
      return [...functionState.globalMetadata.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    },
    getGlobal: (args) => {
      requireGlobalAccess();
      const name = requiredName(args);
      const source = functionState.global.get(name);
      if (!source) {
        throw new Error(`Global function "${name}" is unavailable`);
      }
      return { ...functionState.globalMetadata.get(name), source };
    },
    removeGlobal: async (args) => {
      requireGlobalAccess();
      const name = requiredName(args);
      if (!ctx.hasUI) {
        throw new Error("Global function removal requires interactive confirmation");
      }
      const confirmed = await ctx.ui.confirm(
        `Remove global function ${name}?`,
        `Delete ${globalFunctionPath(name)} for every project?`,
      );
      if (!confirmed) {
        throw new Error("Global function removal was cancelled");
      }
      const removed = await service.removeFromGlobal(name);
      if (removed) {
        activity.push({ action: "remove", name, scope: "global" });
      }
      return { name, removed };
    },
  };
}

export function createFunctionCapabilityMethods({
  pi,
  ctx,
  functionState,
  commitFunctionState,
  activity,
}: FunctionCapabilityServices): Record<FunctionMethod, FunctionMethodHandler> {
  const service = new SavedFunctionService({
    state: functionState,
    commit: commitFunctionState,
    appendEntry: (type, entry) => pi.appendEntry(type, entry),
  });
  const requireProjectAccess = (): void => {
    if (!ctx.isProjectTrusted()) {
      throw new Error("Project functions require a trusted project");
    }
    if (!functionState.projectEnabled) {
      throw new Error(
        `Project functions are disabled. Enable them in ${CONFIG_DIR_NAME}/pit.json with {"projectFunctions":{"enabled":true}}`,
      );
    }
  };
  const requireGlobalAccess = (): void => {
    if (!functionState.globalEnabled) {
      throw new Error(
        `Global functions are disabled. Enable them in ${globalFunctionConfigPath()}`,
      );
    }
  };

  return {
    ...createPersistentFunctionHandlers({
      ctx,
      functionState,
      commitFunctionState,
      activity,
      service,
      requireProjectAccess,
      requireGlobalAccess,
    }),
    listAll: () =>
      [...functionState.effective.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, source]) => savedMetadata({ functionState, service, name, source })),
    getSaved: (args) => {
      const name = requiredName(args);
      const requestedScope = functionScope(args[1]);
      const scope = requestedScope ?? effectiveScope(functionState, name);
      const source = sourceForScope(functionState, name, scope);
      if (!source) {
        throw new Error(
          `${requestedScope ? `${scope[0]?.toUpperCase()}${scope.slice(1)} ` : ""}saved function "${name}" is unavailable`,
        );
      }
      return {
        ...savedMetadata({ functionState, service, name, source, requestedScope: scope }),
        source,
      };
    },
    planRemoval: (args) => service.planRemoval(requiredName(args), functionScope(args[1])),
    promote: async (args) => {
      const name = requiredName(args);
      const summary = string(args[1], "summary");
      const target = promotionTarget(args[2]);
      if (target === "project") {
        requireProjectAccess();
        await service.promoteToProject({ name, summary, context: ctx, activity });
      } else {
        requireGlobalAccess();
        if (!ctx.hasUI) {
          throw new Error("Global function promotion requires interactive confirmation");
        }
        const confirmed = await ctx.ui.confirm(
          `Save ${name} globally?`,
          `Make ${name} available in every Pit project under ${globalFunctionDirectory()}?`,
        );
        if (!confirmed) {
          throw new Error("Global function promotion was cancelled");
        }
        await service.promoteToGlobal({ name, summary, context: ctx, activity });
      }
      return { name, promoted: true as const, scope: target };
    },
    removeSession: (args) => {
      const name = requiredName(args);
      const cascade = removalCascade(args[1]);
      return service.removeSession(name, { cascade }).then((removed) => {
        for (const removedName of removed) {
          activity.push({ action: "remove", name: removedName, scope: "session" });
        }
        return { name, removed };
      });
    },
  };
}
