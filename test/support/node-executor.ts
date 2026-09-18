import { nodeFunctionExecutor } from "../../src/sandbox/node-executor.js";

/** Bypass portable authoring validation to test the Node executor's own security boundary. */
export function runRawNodeProgram(compiled: string): Promise<unknown> {
  return nodeFunctionExecutor.execute(
    { compiled, effects: [] },
    async () => {
      throw new Error("Unexpected host call from a raw Node fixture");
    },
    { memoryLimitMb: 128, timeoutMs: 30_000 },
  );
}
