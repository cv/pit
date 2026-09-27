import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { FunctionActivity } from "./core.js";
import { createFunctionHostMethods } from "./host-methods.js";
import type { FunctionState, FunctionStateCommit } from "./state.js";

interface FunctionHostServices {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  functionState: FunctionState;
  commitFunctionState: FunctionStateCommit;
  activity: FunctionActivity[];
}

type FunctionHostHandler = (
  method: string,
  args: unknown[],
  signal: AbortSignal,
) => unknown | Promise<unknown>;

export function createFunctionHostHandler(services: FunctionHostServices): FunctionHostHandler {
  const methods = createFunctionHostMethods(services);
  return (method, args, signal) => methods[method as keyof typeof methods]?.(args, signal);
}
