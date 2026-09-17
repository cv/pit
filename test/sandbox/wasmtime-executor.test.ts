import { describe, expect, it, vi } from "vitest";

import type { PreparedSandboxProgram } from "../../src/sandbox/program.js";
import {
  createWasmtimeFunctionExecutor,
  type WasmtimeAddon,
} from "../../src/sandbox/wasmtime-executor.js";

const program = (effects: string[]): PreparedSandboxProgram => ({
  compiled: "async () => 42",
  effects,
});
const options = { memoryLimitMb: 64, timeoutMs: 500 };

describe("createWasmtimeFunctionExecutor", () => {
  it("dispatches granted calls and returns the guest result", async () => {
    const executeQueuedJavascript = vi.fn<WasmtimeAddon["executeQueuedJavascript"]>(
      async (_component, _source, callback) => {
        const response = JSON.parse(
          await callback(
            JSON.stringify({
              type: "call",
              id: 1,
              capability: "context",
              method: "get",
              args: [],
            }),
          ),
        );
        expect(response.value).toEqual({ cwd: "/workspace" });
        await callback(JSON.stringify({ type: "result", value: { ok: true } }));
        return true;
      },
    );
    const executor = createWasmtimeFunctionExecutor({
      addon: { executeQueuedJavascript },
      component: new Uint8Array([1, 2, 3]),
    });
    const handler = vi.fn(async () => ({ cwd: "/workspace" }));

    await expect(executor.execute(program(["context.get"]), handler, options)).resolves.toEqual({
      ok: true,
    });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "context", method: "get" }),
    );
    expect(executeQueuedJavascript).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.stringContaining("pitCall"),
      expect.any(Function),
      4_000_000_000,
      500,
      64,
    );
  });

  it("returns grant failures to the guest and requires a result", async () => {
    const addon: WasmtimeAddon = {
      async executeQueuedJavascript(_component, _source, callback) {
        const response = JSON.parse(
          await callback(
            JSON.stringify({
              type: "call",
              id: 2,
              capability: "shell",
              method: "exec",
              args: ["true"],
            }),
          ),
        );
        expect(response.error).toBe("Function grant does not allow shell.exec");
        return true;
      },
    };
    const executor = createWasmtimeFunctionExecutor({ addon, component: new Uint8Array() });

    await expect(executor.execute(program([]), async () => null, options)).rejects.toThrow(
      "completed without a result",
    );
  });

  it("rejects already-cancelled executions before entering native code", async () => {
    const controller = new AbortController();
    controller.abort();
    const addon = { executeQueuedJavascript: vi.fn() } as unknown as WasmtimeAddon;
    const executor = createWasmtimeFunctionExecutor({ addon, component: new Uint8Array() });

    await expect(
      executor.execute(program([]), async () => null, { ...options, signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    expect(addon.executeQueuedJavascript).not.toHaveBeenCalled();
  });
});
