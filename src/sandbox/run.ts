import type { HostCallTrace } from "../execution/host-call-trace.js";
import type { ExecutionTimingRecorder } from "../execution/timings.js";
import type { FunctionEnvironment, FunctionDefinitionReference } from "../functions/environment.js";
import type { HostCallHandler } from "./dispatcher.js";
import type { FunctionExecutionOptions, FunctionExecutor } from "./executor.js";
import { prepareSandboxProgram } from "./program.js";

export interface SandboxOptions extends FunctionEnvironment {
  definition?: FunctionDefinitionReference;
  timings?: ExecutionTimingRecorder;
  memoryLimitMb?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  input?: unknown;
  onHostCallTrace?: (trace: HostCallTrace) => void;
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
    ...(options.onHostCallTrace ? { onHostCallTrace: options.onHostCallTrace } : {}),
  };
}

export async function runWithFunctionExecutor(
  source: string,
  handler: HostCallHandler,
  options: SandboxOptions,
  executor: FunctionExecutor,
): Promise<unknown> {
  const execution = executionOptions(options);
  const program = await prepareSandboxProgram(source, {
    ...(options.timings ? { timings: options.timings } : {}),
    ...(options.definition ? { definition: options.definition } : {}),
    ...(options.invalidDefinitions ? { invalidDefinitions: options.invalidDefinitions } : {}),
    ...(options.userFunctions ? { userFunctions: options.userFunctions } : {}),
    ...(options.projectFunctions ? { projectFunctions: options.projectFunctions } : {}),
    ...(options.sessionFunctions ? { sessionFunctions: options.sessionFunctions } : {}),
    ...(options.toolCatalog ? { toolCatalog: options.toolCatalog } : {}),
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  options.timings?.enter("execution");
  return executor.execute(program, handler, execution);
}
