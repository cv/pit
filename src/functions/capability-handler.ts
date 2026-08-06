import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createFunctionCapabilityMethods } from "./capability-methods.js";
import type { FunctionActivity } from "./core.js";
import type { FunctionState, FunctionStateCommit } from "./state.js";

interface FunctionCapabilityServices {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  functionState: FunctionState;
  commitFunctionState: FunctionStateCommit;
  activity: FunctionActivity[];
}

type FunctionCapabilityHandler = (method: string, args: unknown[]) => unknown | Promise<unknown>;

export function createFunctionCapabilityHandler(
  services: FunctionCapabilityServices,
): FunctionCapabilityHandler {
  const methods = createFunctionCapabilityMethods(services);
  return (method, args) => methods[method as keyof typeof methods]?.(args);
}
