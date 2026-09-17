import type { CapabilityTrace } from "../execution/capability-trace.js";
import type { CapabilityHandler } from "./dispatcher.js";
import {
  parseFunctionExecutionContext,
  type FunctionExecutionOptions,
  type FunctionExecutor,
} from "./executor.js";
import { nodeFunctionExecutor, SandboxRemoteError, sandboxFatalError } from "./node-executor.js";
import { prepareSandboxProgram } from "./program.js";

export {
  nodeFunctionExecutor,
  parseFunctionExecutionContext,
  SandboxRemoteError,
  sandboxFatalError,
};

export interface SandboxOptions {
  memoryLimitMb?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  userFunctions?: ReadonlyMap<string, string>;
  projectFunctions?: ReadonlyMap<string, string>;
  sessionFunctions?: ReadonlyMap<string, string>;
  input?: unknown;
  onCapabilityTrace?: (trace: CapabilityTrace) => void;
}

function executionOptions(options: SandboxOptions): FunctionExecutionOptions {
  const memoryLimitMb = options.memoryLimitMb ?? 128;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(memoryLimitMb) || memoryLimitMb < 16) {
    throw new Error("memoryLimitMb must be at least 16");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new Error("timeoutMs must be positive");
  }
  return {
    memoryLimitMb,
    timeoutMs,
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onCapabilityTrace ? { onCapabilityTrace: options.onCapabilityTrace } : {}),
  };
}

export async function runWithFunctionExecutor(
  source: string,
  handler: CapabilityHandler,
  options: SandboxOptions,
  executor: FunctionExecutor,
): Promise<unknown> {
  const execution = executionOptions(options);
  const program = await prepareSandboxProgram(source, {
    ...(options.userFunctions ? { userFunctions: options.userFunctions } : {}),
    ...(options.projectFunctions ? { projectFunctions: options.projectFunctions } : {}),
    ...(options.sessionFunctions ? { sessionFunctions: options.sessionFunctions } : {}),
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  return executor.execute(program, handler, execution);
}

/** @deprecated Use `configuredFunctionExecutor()` and `runWithFunctionExecutor()`. */
export function runInSandbox(
  source: string,
  handler: CapabilityHandler,
  options: SandboxOptions = {},
): Promise<unknown> {
  return runWithFunctionExecutor(source, handler, options, nodeFunctionExecutor);
}
