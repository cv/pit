import type { PitHostApi, PitHostContext } from "../host/context.js";
import type { FunctionActivity } from "./core.js";
import { createFunctionHostMethods } from "./host-methods.js";
import type { FunctionState, FunctionStateCommit } from "./state.js";

interface FunctionHostServices {
  pi: Pick<PitHostApi, "appendEntry">;
  ctx: PitHostContext;
  functionState: FunctionState;
  commitFunctionState: FunctionStateCommit;
  activity: FunctionActivity[];
  /** Asks the host's UI before writing or removing project function files. */
  confirmProjectWrites?: boolean;
  /** Added to a project promotion's result. */
  projectPromotionNote?: string;
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
