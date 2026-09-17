import type { CapabilityTrace, FunctionExecutionContext } from "../execution/capability-trace.js";
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

const FUNCTION_EXECUTION_SCOPES = new Set(["global", "user", "project", "session"]);

export function parseFunctionExecutionContext(
  value: unknown,
): FunctionExecutionContext | undefined {
  if (!(value && typeof value === "object" && !Array.isArray(value))) return;
  const context = value as Record<string, unknown>;
  if (
    !(
      Number.isSafeInteger(context.invocationId) &&
      Number(context.invocationId) > 0 &&
      typeof context.name === "string" &&
      context.name.length > 0
    ) ||
    !FUNCTION_EXECUTION_SCOPES.has(String(context.scope)) ||
    !(
      Number.isSafeInteger(context.depth) &&
      Number(context.depth) >= 1 &&
      Number(context.depth) <= 32
    ) ||
    !(
      context.parentInvocationId === undefined ||
      (Number.isSafeInteger(context.parentInvocationId) && Number(context.parentInvocationId) > 0)
    )
  ) {
    return;
  }
  return context as unknown as FunctionExecutionContext;
}
