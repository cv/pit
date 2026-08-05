import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { CAPABILITY_METHODS } from "./capability-registry.js";
import { recordValue as record, stringValue as string } from "./cli.js";
import type { FunctionState, FunctionStateCommit } from "./function-state.js";
import { getSavedFunctionCallSignature, getSavedFunctionDependencyGraph } from "./sandbox.js";
import { removeProjectFunctionFromState, SavedFunctionService } from "./saved-function-service.js";
import type { FunctionActivity } from "./saved-functions.js";
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

function removalScope(value: unknown): "project" | "session" | undefined {
  const scope = value === undefined ? undefined : string(value, "function scope");
  if (scope !== undefined && scope !== "project" && scope !== "session") {
    throw new Error('function scope must be "project" or "session"');
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

function savedMetadata(
  functionState: FunctionState,
  service: SavedFunctionService,
  name: string,
  source: string,
) {
  const scope = functionState.session.has(name) ? ("session" as const) : ("project" as const);
  const graph = getSavedFunctionDependencyGraph(
    scope === "session" ? functionState.effective : functionState.project,
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
    listAll: () =>
      [...functionState.effective.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, source]) => savedMetadata(functionState, service, name, source)),
    getSaved: (args) => {
      const name = requiredName(args);
      const source = functionState.effective.get(name);
      if (!source) {
        throw new Error(`Saved function "${name}" is unavailable`);
      }
      return { ...savedMetadata(functionState, service, name, source), source };
    },
    planRemoval: (args) => service.planRemoval(requiredName(args), removalScope(args[1])),
    promote: (args) => {
      requireProjectAccess();
      const name = requiredName(args);
      const summary = string(args[1], "summary");
      return service
        .promoteToProject({ name, summary, context: ctx, activity })
        .then(() => ({ name, promoted: true as const }));
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
