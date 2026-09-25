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
  it.each<{ name: string; interrupted: boolean; expected: object }>([
    {
      name: "did not reach the guest",
      interrupted: false,
      expected: { name: "RangeError", message: "guest boom" },
    },
    {
      name: "interrupted the guest",
      interrupted: true,
      expected: { name: "TimeoutError", message: expect.stringContaining("timed out") },
    },
  ])("classifies a deadline stop that $name", async ({ interrupted, expected }) => {
    // The deadline passes before the guest fails; only a stop that reached it is a timeout.
    const addon: WasmtimeAddon = {
      interruptQueuedJavascript: () => interrupted,
      async executeQueuedJavascript(_component, _source, callback) {
        await new Promise((resolve) => setTimeout(resolve, 80));
        await callback(
          JSON.stringify({ type: "failure", name: "RangeError", message: "guest boom" }),
        );
        throw new Error("RangeError: guest boom\n    at <anonymous> (<input>:32:110)");
      },
    };
    const executor = createWasmtimeFunctionExecutor({ addon, component: new Uint8Array() });

    await expect(
      executor.execute(program([]), async () => null, { memoryLimitMb: 64, timeoutMs: 20 }),
    ).rejects.toMatchObject(expected);
  });

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
              functionContext: {
                invocationId: 1,
                name: "inspect",
                scope: "user",
                depth: 2,
                parentInvocationId: 7,
              },
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
    const traces = vi.fn();
    const controller = new AbortController();

    await expect(
      executor.execute(program(["context.get"]), handler, {
        ...options,
        signal: controller.signal,
        onCapabilityTrace: traces,
      }),
    ).resolves.toEqual({
      ok: true,
    });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "context",
        method: "get",
        functionContext: expect.objectContaining({
          name: "inspect",
          scope: "user",
          depth: 2,
          parentInvocationId: 7,
        }),
      }),
    );
    expect(traces).toHaveBeenCalled();
    expect(executeQueuedJavascript).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.stringContaining("pitCall"),
      expect.any(Function),
      Number.MAX_SAFE_INTEGER,
      500,
      64,
      expect.any(String),
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
      "finished without a result",
    );
  });

  it.each<{ name: string; failure: unknown }>([
    { name: "Error", failure: new Error("wasm trap: interrupt") },
    { name: "non-Error", failure: "wasm trap: interrupt" },
  ])("normalizes $name Wasmtime interrupt traps as execution timeouts", async ({ failure }) => {
    const addon: WasmtimeAddon = {
      async executeQueuedJavascript() {
        throw failure;
      },
    };
    const executor = createWasmtimeFunctionExecutor({ addon, component: new Uint8Array() });

    await expect(executor.execute(program([]), async () => null, options)).rejects.toMatchObject({
      name: "TimeoutError",
      message: "TypeScript execution timed out after 500ms",
    });
  });

  it("normalizes Wasmtime fuel exhaustion", async () => {
    const addon: WasmtimeAddon = {
      async executeQueuedJavascript() {
        throw new Error("wasm trap: all fuel consumed by WebAssembly");
      },
    };
    const executor = createWasmtimeFunctionExecutor({ addon, component: new Uint8Array() });

    await expect(executor.execute(program([]), async () => null, options)).rejects.toThrow(
      "TypeScript execution exceeded its fuel limit",
    );
  });

  it("rejects already-cancelled executions before entering native code", async () => {
    const controller = new AbortController();
    controller.abort();
    const addon = { executeQueuedJavascript: vi.fn() } as unknown as WasmtimeAddon;
    const executor = createWasmtimeFunctionExecutor({ addon, component: new Uint8Array() });

    await expect(
      executor.execute(program([]), async () => null, { ...options, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError", message: "TypeScript execution cancelled" });
    expect(addon.executeQueuedJavascript).not.toHaveBeenCalled();
  });

  it.each<{ name: string; frames: string[]; expectedName: string }>([
    {
      name: "a reported termination name",
      frames: [JSON.stringify({ type: "failure", name: "TimeoutError" })],
      expectedName: "TimeoutError",
    },
    { name: "no reported name", frames: [], expectedName: "Error" },
  ])("rejects an uncaught guest failure with $name", async ({ frames, expectedName }) => {
    const addon: WasmtimeAddon = {
      async executeQueuedJavascript(_component, _source, callback) {
        for (const frame of frames) await callback(frame);
        throw new Error("deadline reached");
      },
    };
    const executor = createWasmtimeFunctionExecutor({ addon, component: new Uint8Array() });

    await expect(executor.execute(program([]), async () => null, options)).rejects.toMatchObject({
      name: expectedName,
      message: "deadline reached",
    });
  });

  it.each([JSON.stringify({ type: "unknown" }), "null"])(
    "rejects invalid guest protocol message %s",
    async (message) => {
      const addon: WasmtimeAddon = {
        async executeQueuedJavascript(_component, _source, callback) {
          await callback(message);
          return true;
        },
      };
      const executor = createWasmtimeFunctionExecutor({ addon, component: new Uint8Array() });
      await expect(executor.execute(program([]), async () => null, options)).rejects.toThrow(
        "Invalid Pit guest request",
      );
    },
  );

  it("completes bounded guest timers", async () => {
    const addon: WasmtimeAddon = {
      async executeQueuedJavascript(_component, _source, callback) {
        expect(JSON.parse(await callback(JSON.stringify({ type: "timer", delayMs: 0 })))).toEqual({
          value: null,
        });
        await callback(JSON.stringify({ type: "result", value: "timer-complete" }));
        return true;
      },
    };
    const executor = createWasmtimeFunctionExecutor({ addon, component: new Uint8Array() });
    await expect(executor.execute(program([]), async () => null, options)).resolves.toBe(
      "timer-complete",
    );
  });

  it("rejects guest timers beyond the execution timeout", async () => {
    const addon: WasmtimeAddon = {
      async executeQueuedJavascript(_component, _source, callback) {
        await callback(JSON.stringify({ type: "timer", delayMs: 501 }));
        return true;
      },
    };
    const executor = createWasmtimeFunctionExecutor({ addon, component: new Uint8Array() });
    await expect(executor.execute(program([]), async () => null, options)).rejects.toThrow(
      "Pit guest timer exceeds execution timeout",
    );
  });

  it("normalizes an externally aborted native failure as cancellation", async () => {
    const controller = new AbortController();
    const interruptQueuedJavascript = vi.fn(() => true);
    const addon: WasmtimeAddon = {
      interruptQueuedJavascript,
      async executeQueuedJavascript() {
        controller.abort();
        throw new Error("wasm trap: interrupt");
      },
    };
    const executor = createWasmtimeFunctionExecutor({ addon, component: new Uint8Array() });
    await expect(
      executor.execute(program([]), async () => null, { ...options, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError", message: "TypeScript execution cancelled" });
    expect(interruptQueuedJavascript).toHaveBeenCalledWith(expect.any(String));
  });
});
