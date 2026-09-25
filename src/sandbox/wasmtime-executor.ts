import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { terminationError } from "../shared/termination-errors.js";
import { CapabilityDispatcher, type CapabilityHandler } from "./dispatcher.js";
import {
  parseFunctionExecutionContext,
  type FunctionExecutionOptions,
  type FunctionExecutor,
} from "./executor.js";
import { createWasmtimeGuestSource } from "./wasmtime-source.js";
import type { WireMessage } from "./wire.js";
import { isCapabilityCallMessage } from "./wire.js";

const MAX_PROTOCOL_FRAME_BYTES = 8_000_000;
const MAX_CAPABILITY_CALLS = 1_024;
const MAX_CONCURRENT_CAPABILITY_CALLS = 32;
const DEFAULT_FUEL = Number.MAX_SAFE_INTEGER;

export interface WasmtimeAddon {
  interruptQueuedJavascript?(executionId: string): boolean;
  executeQueuedJavascript(
    component: Uint8Array,
    source: string,
    callback: (request: string) => Promise<string>,
    fuel?: number,
    timeoutMs?: number,
    memoryLimitMb?: number,
    executionId?: string,
  ): Promise<boolean>;
}

interface TimerRequest {
  type: "timer";
  delayMs: number;
}

function isTimerRequest(
  request: Record<string, unknown>,
): request is Record<string, unknown> & TimerRequest {
  return (
    request.type === "timer" &&
    Number.isSafeInteger(request.delayMs) &&
    Number(request.delayMs) >= 0
  );
}

export interface WasmtimeFunctionExecutorOptions {
  addon: WasmtimeAddon;
  component: Uint8Array;
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
      if (options.signal?.aborted)
        throw terminationError("cancelled", "TypeScript execution cancelled");
      const signal = executionSignal(options);
      const waiters = new Map<number, (response: string) => void>();
      let resultReceived = false;
      let result: unknown;
      let guestFailure: { name: string; message?: string } | undefined;
      const dispatcher = new CapabilityDispatcher({
        handler,
        signal,
        maximumCalls: MAX_CAPABILITY_CALLS,
        maximumConcurrentCalls: MAX_CONCURRENT_CAPABILITY_CALLS,
        allowedCalls: new Set(program.effects),
        parseFunctionContext: parseFunctionExecutionContext,
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
        const value = JSON.parse(raw) as unknown;
        if (!(value && typeof value === "object" && !Array.isArray(value))) {
          throw new Error("Invalid Pit guest request");
        }
        const request = value as Record<string, unknown>;
        if (isTimerRequest(request)) {
          if (request.delayMs > options.timeoutMs) {
            throw new Error("Pit guest timer exceeds execution timeout");
          }
          await delay(request.delayMs, undefined, { signal });
          return JSON.stringify({ value: null });
        }
        if (request.type === "failure") {
          guestFailure = {
            name: typeof request.name === "string" ? request.name.slice(0, 100) : "Error",
            ...(typeof request.message === "string" ? { message: request.message } : {}),
          };
          return JSON.stringify({ value: null });
        }
        const message = request as WireMessage;
        if (message.type === "result") {
          resultReceived = true;
          result = message.value;
          return JSON.stringify({ value: null });
        }
        if (!isCapabilityCallMessage(message)) {
          throw new Error("Invalid Pit guest request");
        }
        // After the deadline or cancellation, answer without dispatching to a handler.
        if (stopped) {
          affected = true;
          return stoppedResponse(message.id);
        }
        return new Promise<string>((resolve) => {
          waiters.set(message.id, resolve);
          dispatcher.handle(message);
        });
      };
      const executionId = randomUUID();
      let stopped: "timeout" | "cancelled" | undefined;
      // Whether stopping reached the guest; a guest that failed on its own keeps its error.
      let affected = false;
      const stoppedResponse = (id: number): string =>
        JSON.stringify({
          type: "response",
          id,
          error:
            stopped === "cancelled"
              ? "TypeScript execution cancelled"
              : `TypeScript execution timed out after ${options.timeoutMs}ms`,
        });
      const interrupt = (): boolean => {
        try {
          return addon.interruptQueuedJavascript?.(executionId) === true;
        } catch {
          // Native timeout interruption remains a bounded fallback if explicit cancellation fails.
          return false;
        }
      };
      // The deadline holds even when a capability handler ignores its abort signal: answer every
      // waiting guest call so the guest resumes, then interrupt it natively.
      const stop = (): void => {
        stopped = options.signal?.aborted ? "cancelled" : "timeout";
        affected = waiters.size > 0;
        for (const [id, waiter] of waiters) waiter(stoppedResponse(id));
        waiters.clear();
        affected = interrupt() || affected;
      };
      signal.addEventListener("abort", stop, { once: true });
      try {
        await addon.executeQueuedJavascript(
          component,
          source,
          callback,
          DEFAULT_FUEL,
          options.timeoutMs,
          options.memoryLimitMb,
          executionId,
        );
      } catch (error) {
        if (options.signal?.aborted) {
          throw terminationError("cancelled", "TypeScript execution cancelled", { cause: error });
        }
        const message = error instanceof Error ? error.message : String(error);
        // Report a timeout only when this executor stopped the guest or the native deadline
        // interrupted it; a guest's own error stays its error even if the budget also elapsed.
        if ((stopped === "timeout" && affected) || /wasm trap: interrupt/i.test(message)) {
          throw terminationError(
            "timeout",
            `TypeScript execution timed out after ${options.timeoutMs}ms`,
            { cause: error },
          );
        }
        if (/all fuel consumed|out of fuel/i.test(message)) {
          throw new Error("TypeScript execution exceeded its fuel limit", { cause: error });
        }
        if (guestFailure) {
          // The guest's own message excludes the native stack frame of the generated program.
          const failure = new Error(guestFailure.message ?? message, { cause: error });
          if (guestFailure.name !== "Error") failure.name = guestFailure.name;
          throw failure;
        }
        throw error;
      } finally {
        signal.removeEventListener("abort", stop);
      }
      // With no pending host work, the guest can only finish early by awaiting a promise that
      // nothing will settle; report that immediately instead of waiting for the deadline.
      if (!resultReceived) {
        throw new Error(
          "TypeScript program finished without a result: it awaited a promise that never settles",
        );
      }
      return result;
    },
  };
}
