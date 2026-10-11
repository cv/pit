import { createCodemodeFunctionExecutor } from "../../src/sandbox/codemode-executor.js";
import type { HostCallHandler } from "../../src/sandbox/dispatcher.js";
import { runWithFunctionExecutor, type SandboxOptions } from "../../src/sandbox/run.js";

const executor = createCodemodeFunctionExecutor();

/** Runs a program in the codemode sandbox, exactly as the extension does. */
export function runInSandbox(
  source: string,
  handler: HostCallHandler,
  options: SandboxOptions = {},
): Promise<unknown> {
  return runWithFunctionExecutor(source, handler, options, executor);
}

/** Executes compiled guest code without authoring validation, to test the runtime's own boundary. */
export function runRawProgram(
  compiled: string,
  handler: HostCallHandler = async () => {
    throw new Error("unexpected host call");
  },
): Promise<unknown> {
  return executor.execute({ compiled, effects: [] }, handler, {
    memoryLimitMb: 64,
    timeoutMs: 5_000,
  });
}
