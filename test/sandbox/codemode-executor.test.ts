import { describe, expect, it, vi } from "vitest";

import { createCodemodeFunctionExecutor } from "../../src/sandbox/codemode-executor.js";

// Compiled guest programs run in the real codemode sandbox; source validation is bypassed so
// these cases can reach the bridge and the sandbox's own globals directly.
const executor = createCodemodeFunctionExecutor();
const options = { memoryLimitMb: 64, timeoutMs: 2_000 };
const run = (compiled: string, handler = vi.fn(async () => null), extra: object = {}) =>
  executor.execute({ compiled, effects: ["context.get"] }, handler, { ...options, ...extra });

describe("createCodemodeFunctionExecutor", () => {
  it.each<{ name: string; frame: unknown }>([
    { name: "unknown message kind", frame: { type: "unknown" } },
    { name: "null frame", frame: null },
    { name: "missing namespace", frame: { type: "call", id: 1, method: "get", args: [] } },
    {
      name: "invalid call id",
      frame: { type: "call", id: "bad", namespace: "context", method: "get", args: [] },
    },
    {
      name: "invalid argument list",
      frame: { type: "call", id: 1, namespace: "context", method: "get", args: null },
    },
  ])("rejects a forged $name before dispatch", async ({ frame }) => {
    const handler = vi.fn(async () => null);
    await expect(
      run(`async () => globalThis.pitCall(${JSON.stringify(JSON.stringify(frame))})`, handler),
    ).rejects.toThrow("Invalid Pit guest request");
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects a guest timer longer than the execution timeout", async () => {
    await expect(
      run("async () => new Promise((resolve) => setTimeout(resolve, 2_001))"),
    ).rejects.toThrow("Pit guest timer exceeds execution timeout");
  });

  it.each<{ name: string; compiled: string }>([
    { name: "awaits a promise nothing settles", compiled: "async () => new Promise(() => {})" },
    { name: "ends through the sandbox's exit()", compiled: "async () => globalThis.exit()" },
  ])("reports a program that $name as finishing without a result", async ({ compiled }) => {
    await expect(run(compiled)).rejects.toThrow("finished without a result");
  });

  it("hides the sandbox's helpers and discards console output", async () => {
    // The sandbox caps console calls at 100,000 per script; discarded output never reaches it.
    await expect(
      run(`async () => {
        for (let index = 0; index < 150_000; index++) console.log(index);
        return [typeof pitCall, typeof text, typeof image, typeof store, typeof load, typeof ALL_TOOLS];
      }`),
    ).resolves.toEqual(Array(6).fill("undefined"));
  });

  it("rejects an already-cancelled execution as cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      run("async () => 1", undefined, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError", message: "TypeScript execution cancelled" });
  });
});
