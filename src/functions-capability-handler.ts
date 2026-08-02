import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { stringValue as string } from "./cli.js";
import type { FunctionState, FunctionStateCommit } from "./function-state.js";
import { getSavedFunctionCallSignature } from "./sandbox.js";
import { removeProjectFunctionFromState, SavedFunctionService } from "./saved-function-service.js";
import type { FunctionActivity } from "./saved-functions.js";
import { validateSavedFunctionName } from "./saved-functions.js";

interface FunctionCapabilityServices {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  functionState: FunctionState;
  commitFunctionState: FunctionStateCommit;
  activity: FunctionActivity[];
}

type FunctionCapabilityHandler = (method: string, args: unknown[]) => unknown | Promise<unknown>;

export function createFunctionCapabilityHandler({
  pi,
  ctx,
  functionState,
  commitFunctionState,
  activity,
}: FunctionCapabilityServices): FunctionCapabilityHandler {
  const service = new SavedFunctionService({
    state: functionState,
    commit: commitFunctionState,
    appendEntry: (type, entry) => pi.appendEntry(type, entry),
  });
  const savedMetadata = (name: string, source: string) => ({
    name,
    scope: functionState.session.has(name) ? ("session" as const) : ("project" as const),
    signature: getSavedFunctionCallSignature(source) ?? `${name}()`,
    lines: source.split("\n").length,
    bytes: Buffer.byteLength(source),
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

  return (method, args) => {
    const projectMethod =
      method === "list" || method === "get" || method === "remove" || method === "promote";
    if (projectMethod) {
      requireProjectAccess();
    }
    const name =
      method === "list" || method === "listAll" ? undefined : string(args[0], "function name");
    if (name !== undefined) {
      validateSavedFunctionName(name);
    }
    if (method === "list") {
      return [...functionState.metadata.values()].sort((a, b) => a.name.localeCompare(b.name));
    }
    if (method === "listAll") {
      return [...functionState.effective.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([functionName, source]) => savedMetadata(functionName, source));
    }
    if (method === "get") {
      const source = functionState.project.get(name as string);
      if (!source) {
        throw new Error(`Project function "${name}" is unavailable`);
      }
      return { ...functionState.metadata.get(name as string), source };
    }
    if (method === "getSaved") {
      const source = functionState.effective.get(name as string);
      if (!source) {
        throw new Error(`Saved function "${name}" is unavailable`);
      }
      return { ...savedMetadata(name as string, source), source };
    }
    if (method === "promote") {
      const functionName = name as string;
      const summary = string(args[1], "summary");
      return service
        .promoteToProject({ name: functionName, summary, context: ctx, activity })
        .then(() => ({ name: functionName, promoted: true as const }));
    }
    if (method === "removeSession") {
      const functionName = name as string;
      return service.removeSession(functionName).then((removed) => {
        for (const removedName of removed) {
          activity.push({ action: "remove", name: removedName, scope: "session" });
        }
        return { name: functionName, removed };
      });
    }
    if (method === "remove") {
      const functionName = name as string;
      return removeProjectFunctionFromState({
        cwd: ctx.cwd,
        name: functionName,
        state: functionState,
        commit: commitFunctionState,
      }).then((removed) => {
        if (removed) {
          activity.push({ action: "remove", name: functionName, scope: "project" });
        }
        return { name, removed };
      });
    }
  };
}
