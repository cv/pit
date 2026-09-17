import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { CAPABILITY_METHODS } from "../capabilities/registry.js";
import { recordValue as record, stringValue as string } from "../shared/argument-values.js";
import type { FunctionActivity, FunctionScope } from "./core.js";
import { getSavedFunctionDependencyGraph } from "./graph.js";
import { validateFunctionId as validateSavedFunctionName } from "./identifier.js";
import { removeProjectFunctionFromState, SavedFunctionService } from "./service.js";
import { getSavedFunctionCallSignature } from "./source.js";
import type { FunctionState, FunctionStateCommit } from "./state.js";
import { userFunctionDirectory, userFunctionPath } from "./storage/user.js";

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
  if (scope !== undefined && scope !== "user" && scope !== "project" && scope !== "session") {
    throw new Error('function scope must be "user", "project", or "session"');
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

function promotionTarget(value: unknown): "user" | "project" {
  if (value === undefined) {
    return "project";
  }
  const options = record(value, "promotion options");
  const unknown = Object.keys(options).filter((key) => key !== "to");
  if (unknown.length > 0) {
    throw new Error(`promotion options contain unknown fields: ${unknown.join(", ")}`);
  }
  const target = options.to === undefined ? "project" : string(options.to, "promotion options.to");
  if (target !== "user" && target !== "project") {
    throw new Error('promotion options.to must be "user" or "project"');
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
      : state.user.get(name);
}

function effectiveScope(state: FunctionState, name: string): FunctionScope {
  return state.session.has(name) ? "session" : state.project.has(name) ? "project" : "user";
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
        ? new Map([...functionState.user, ...functionState.project])
        : functionState.user,
  );
  const plan = service.planRemoval(name, scope);
  return {
    name,
    scope,
    /* v8 ignore next -- saved registries contain validated named function declarations. */
    signature: getSavedFunctionCallSignature(source, name) ?? `${name}()`,
    lines: source.split("\n").length,
    bytes: Buffer.byteLength(source),
    directDependencies: [...graph.directDependencies(name)],
    directDependents: plan.directDependents,
    overridesProject: scope === "session" && functionState.project.has(name),
    overridesUser: (scope === "session" || scope === "project") && functionState.user.has(name),
  };
}

type PersistentFunctionMethod = "list" | "get" | "remove" | "listUser" | "getUser" | "removeUser";

interface PersistentFunctionHandlerServices {
  ctx: ExtensionContext;
  functionState: FunctionState;
  commitFunctionState: FunctionStateCommit;
  activity: FunctionActivity[];
  service: SavedFunctionService;
  requireProjectAccess(): void;
}

function createPersistentFunctionHandlers({
  ctx,
  functionState,
  commitFunctionState,
  activity,
  service,
  requireProjectAccess,
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
    listUser: () => {
      return [...functionState.userMetadata.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
    getUser: (args) => {
      const name = requiredName(args);
      const source = functionState.user.get(name);
      if (!source) {
        const detail = functionState.invalidUser.get(name);
        throw new Error(`User function "${name}" is unavailable${detail ? `: ${detail}` : ""}`);
      }
      return { ...functionState.userMetadata.get(name), source };
    },
    removeUser: async (args) => {
      const name = requiredName(args);
      if (!ctx.hasUI) {
        throw new Error("User function removal requires interactive confirmation");
      }
      const confirmed = await ctx.ui.confirm(
        `Remove user function ${name}?`,
        `Delete ${userFunctionPath(name)} for every project?`,
      );
      if (!confirmed) {
        throw new Error("User function removal was cancelled");
      }
      const removed = await service.removeFromUser(name);
      if (removed) {
        activity.push({ action: "remove", name, scope: "user" });
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

  return {
    ...createPersistentFunctionHandlers({
      ctx,
      functionState,
      commitFunctionState,
      activity,
      service,
      requireProjectAccess,
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
        if (!ctx.hasUI) {
          throw new Error("User function promotion requires interactive confirmation");
        }
        const confirmed = await ctx.ui.confirm(
          `Save ${name} to user scope?`,
          `Make ${name} available in every Pit project under ${userFunctionDirectory()}?`,
        );
        if (!confirmed) {
          throw new Error("User function promotion was cancelled");
        }
        await service.promoteToUser({ name, summary, context: ctx, activity });
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
