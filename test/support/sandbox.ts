import type { CapabilityHandler } from "../../src/sandbox/dispatcher.js";
import { runWithFunctionExecutor, type SandboxOptions } from "../../src/sandbox/run.js";
import { configuredFunctionExecutor } from "../../src/sandbox/wasmtime-loader.js";

let executor: ReturnType<typeof configuredFunctionExecutor> | undefined;

/** Runs a program on the configured Wasmtime runtime, exactly as the extension does. */
export function runInSandbox(
  source: string,
  handler: CapabilityHandler,
  options: SandboxOptions = {},
): Promise<unknown> {
  executor ??= configuredFunctionExecutor();
  return runWithFunctionExecutor(source, handler, options, executor);
}

/** Executes compiled guest code without authoring validation, to test the runtime's own boundary. */
export function runRawProgram(
  compiled: string,
  handler: CapabilityHandler = async () => {
    throw new Error("unexpected capability call");
  },
): Promise<unknown> {
  executor ??= configuredFunctionExecutor();
  return executor.execute({ compiled, effects: [] }, handler, {
    memoryLimitMb: 64,
    timeoutMs: 5_000,
  });
}
