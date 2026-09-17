import type { FunctionExecutionContext } from "../execution/capability-trace.js";
import { CapabilityDispatcher, type CapabilityHandler } from "./dispatcher.js";
import type { FunctionExecutionOptions, FunctionExecutor } from "./executor.js";
import { createWasmtimeGuestSource } from "./wasmtime-source.js";
import type { WireMessage } from "./wire.js";
import { isCapabilityCallMessage } from "./wire.js";

const MAX_PROTOCOL_FRAME_BYTES = 8_000_000;
const MAX_CAPABILITY_CALLS = 1_024;
const MAX_CONCURRENT_CAPABILITY_CALLS = 32;
const DEFAULT_FUEL = 4_000_000_000;

export interface WasmtimeAddon {
  executeQueuedJavascript(
    component: Uint8Array,
    source: string,
    callback: (request: string) => Promise<string>,
    fuel?: number,
    timeoutMs?: number,
    memoryLimitMb?: number,
  ): Promise<boolean>;
}

export interface WasmtimeFunctionExecutorOptions {
  addon: WasmtimeAddon;
  component: Uint8Array;
}

function parseFunctionContext(value: unknown): FunctionExecutionContext | undefined {
  if (!(value && typeof value === "object" && !Array.isArray(value))) return;
  const context = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(context.invocationId) ||
    Number(context.invocationId) < 1 ||
    typeof context.name !== "string" ||
    !["global", "project", "session"].includes(String(context.scope)) ||
    !Number.isSafeInteger(context.depth) ||
    Number(context.depth) < 1 ||
    Number(context.depth) > 32
  ) {
    return;
  }
  return context as unknown as FunctionExecutionContext;
}

function executionSignal(options: FunctionExecutionOptions): AbortSignal {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}

export function createWasmtimeFunctionExecutor({
  addon,
  component,
}: WasmtimeFunctionExecutorOptions): FunctionExecutor {
  return {
    async execute(program, handler: CapabilityHandler, options): Promise<unknown> {
      if (options.signal?.aborted) throw new Error("TypeScript execution cancelled");
      const signal = executionSignal(options);
      const waiters = new Map<number, (response: string) => void>();
      let resultReceived = false;
      let result: unknown;
      const dispatcher = new CapabilityDispatcher({
        handler,
        signal,
        maximumCalls: MAX_CAPABILITY_CALLS,
        maximumConcurrentCalls: MAX_CONCURRENT_CAPABILITY_CALLS,
        allowedCalls: new Set(program.effects),
        parseFunctionContext,
        send(message: WireMessage): boolean {
          /* v8 ignore next -- dispatcher responses always carry their request id. */
          if (typeof message.id !== "number") return false;
          const waiter = waiters.get(message.id);
          /* v8 ignore next -- only active dispatcher calls can send responses. */
          if (!waiter) return false;
          const response = JSON.stringify(message);
          /* v8 ignore next -- dispatcher sends a bounded fallback after rejection. */
          if (Buffer.byteLength(response) > MAX_PROTOCOL_FRAME_BYTES) return false;
          waiters.delete(message.id);
          waiter(response);
          return true;
        },
        ...(options.onCapabilityTrace ? { onTrace: options.onCapabilityTrace } : {}),
      });
      const source = createWasmtimeGuestSource(program, options.input);
      const callback = async (raw: string): Promise<string> => {
        if (Buffer.byteLength(raw) > MAX_PROTOCOL_FRAME_BYTES) {
          throw new Error("Pit guest request exceeds bounds");
        }
        const message = JSON.parse(raw) as WireMessage;
        if (message.type === "result") {
          resultReceived = true;
          result = message.value;
          return JSON.stringify({ value: null });
        }
        if (!isCapabilityCallMessage(message)) {
          throw new Error("Invalid Pit guest request");
        }
        return new Promise<string>((resolve) => {
          waiters.set(message.id, resolve);
          dispatcher.handle(message);
        });
      };
      try {
        await addon.executeQueuedJavascript(
          component,
          source,
          callback,
          DEFAULT_FUEL,
          options.timeoutMs,
          options.memoryLimitMb,
        );
      } catch (error) {
        if (options.signal?.aborted) {
          throw new Error("TypeScript execution cancelled", { cause: error });
        }
        const message = error instanceof Error ? error.message : String(error);
        if (signal.aborted || /wasm trap: interrupt/i.test(message)) {
          throw new Error(`TypeScript execution timed out after ${options.timeoutMs}ms`, {
            cause: error,
          });
        }
        throw error;
      }
      if (!resultReceived) throw new Error("QuickJS guest completed without a result");
      return result;
    },
  };
}
