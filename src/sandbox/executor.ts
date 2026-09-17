import type { CapabilityTrace } from "../execution/capability-trace.js";
import type { CapabilityHandler } from "./dispatcher.js";
import type { PreparedSandboxProgram } from "./program.js";

export interface FunctionExecutionOptions {
  memoryLimitMb: number;
  timeoutMs: number;
  input?: unknown;
  signal?: AbortSignal;
  onCapabilityTrace?: (trace: CapabilityTrace) => void;
}

export interface FunctionExecutor {
  execute(
    program: PreparedSandboxProgram,
    handler: CapabilityHandler,
    options: FunctionExecutionOptions,
  ): Promise<unknown>;
}
