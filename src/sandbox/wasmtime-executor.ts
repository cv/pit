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
import type { CapabilityCallMessage, WireMessage } from "./wire.js";
import { isCapabilityCallMessage } from "./wire.js";

const MAX_PROTOCOL_FRAME_BYTES = 8_000_000;
const MAX_CAPABILITY_CALLS = 1_024;
const MAX_CONCURRENT_CAPABILITY_CALLS = 32;
const DEFAULT_FUEL = Number.MAX_SAFE_INTEGER;
const EMPTY_RESPONSE = JSON.stringify({ value: null });

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

/** Parses one bounded guest request into a plain object. */
function parseGuestRequest(raw: string): Record<string, unknown> {
  if (Buffer.byteLength(raw) > MAX_PROTOCOL_FRAME_BYTES) {
    throw new Error("Pit guest request exceeds bounds");
  }
  const value = JSON.parse(raw) as unknown;
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    throw new Error("Invalid Pit guest request");
  }
  return value as Record<string, unknown>;
}

/**
 * The host side of one execution: answers guest requests, dispatches capability calls, stops the
 * guest at the deadline or on cancellation, and classifies how a failed execution ended.
 */
class GuestExecution {
  readonly id = randomUUID();
  readonly signal: AbortSignal;
  resultReceived = false;
  result: unknown;
  readonly #waiters = new Map<number, (response: string) => void>();
  readonly #dispatcher: CapabilityDispatcher;
  #guestFailure: { name: string; message?: string } | undefined;
  #stopped: "timeout" | "cancelled" | undefined;
  // Whether stopping reached the guest; a guest that failed on its own keeps its error.
  #affected = false;

  constructor(
    private readonly addon: WasmtimeAddon,
    handler: CapabilityHandler,
    effects: Iterable<string>,
    private readonly options: FunctionExecutionOptions,
  ) {
    this.signal = executionSignal(options);
    this.#dispatcher = new CapabilityDispatcher({
      handler,
      signal: this.signal,
      maximumCalls: MAX_CAPABILITY_CALLS,
      maximumConcurrentCalls: MAX_CONCURRENT_CAPABILITY_CALLS,
      allowedCalls: new Set(effects),
      parseFunctionContext: parseFunctionExecutionContext,
      send: (message) => this.#reply(message),
      ...(options.onCapabilityTrace ? { onTrace: options.onCapabilityTrace } : {}),
    });
  }

  /** Answers one guest request. The addon calls this for every request the guest queues. */
  readonly handle = async (raw: string): Promise<string> => {
    const request = parseGuestRequest(raw);
    if (isTimerRequest(request)) return this.#wait(request.delayMs);
    if (request.type === "failure") {
      this.#guestFailure = {
        name: typeof request.name === "string" ? request.name.slice(0, 100) : "Error",
        ...(typeof request.message === "string" ? { message: request.message } : {}),
      };
      return EMPTY_RESPONSE;
    }
    const message = request as WireMessage;
    if (message.type === "result") {
      this.resultReceived = true;
      this.result = message.value;
      return EMPTY_RESPONSE;
    }
    if (!isCapabilityCallMessage(message)) throw new Error("Invalid Pit guest request");
    return this.#call(message);
  };

  /**
   * The deadline holds even when a capability handler ignores its abort signal: answer every
   * waiting guest call so the guest resumes, then interrupt it natively.
   */
  readonly stop = (): void => {
    this.#stopped = this.options.signal?.aborted ? "cancelled" : "timeout";
    this.#affected = this.#waiters.size > 0;
    for (const [id, waiter] of this.#waiters) waiter(this.#stoppedResponse(id));
    this.#waiters.clear();
    this.#affected = this.#interrupt() || this.#affected;
  };

  /** The error to report for a failed native execution. Other thrown values pass through. */
  failure(error: unknown): unknown {
    if (this.options.signal?.aborted) {
      return terminationError("cancelled", "TypeScript execution cancelled", { cause: error });
    }
    const message = error instanceof Error ? error.message : String(error);
    // Report a timeout only when this executor stopped the guest or the native deadline
    // interrupted it; a guest's own error stays its error even if the budget also elapsed.
    if ((this.#stopped === "timeout" && this.#affected) || /wasm trap: interrupt/i.test(message)) {
      return terminationError(
        "timeout",
        `TypeScript execution timed out after ${this.options.timeoutMs}ms`,
        { cause: error },
      );
    }
    if (/all fuel consumed|out of fuel/i.test(message)) {
      return new Error("TypeScript execution exceeded its fuel limit", { cause: error });
    }
    if (this.#guestFailure) {
      // The guest's own message excludes the native stack frame of the generated program.
      const failure = new Error(this.#guestFailure.message ?? message, { cause: error });
      if (this.#guestFailure.name !== "Error") failure.name = this.#guestFailure.name;
      return failure;
    }
    return error;
  }

  #call(message: CapabilityCallMessage): Promise<string> {
    // After the deadline or cancellation, answer without dispatching to a handler.
    if (this.#stopped) {
      this.#affected = true;
      return Promise.resolve(this.#stoppedResponse(message.id));
    }
    return new Promise<string>((resolve) => {
      this.#waiters.set(message.id, resolve);
      this.#dispatcher.handle(message);
    });
  }

  async #wait(delayMs: number): Promise<string> {
    if (delayMs > this.options.timeoutMs) {
      throw new Error("Pit guest timer exceeds execution timeout");
    }
    await delay(delayMs, undefined, { signal: this.signal });
    return EMPTY_RESPONSE;
  }

  #reply(message: WireMessage): boolean {
    /* v8 ignore next -- dispatcher responses always carry their request id. */
    if (typeof message.id !== "number") return false;
    const waiter = this.#waiters.get(message.id);
    /* v8 ignore next -- only active dispatcher calls can send responses. */
    if (!waiter) return false;
    const response = JSON.stringify(message);
    /* v8 ignore next -- dispatcher sends a bounded fallback after rejection. */
    if (Buffer.byteLength(response) > MAX_PROTOCOL_FRAME_BYTES) return false;
    this.#waiters.delete(message.id);
    waiter(response);
    return true;
  }

  #stoppedResponse(id: number): string {
    return JSON.stringify({
      type: "response",
      id,
      error:
        this.#stopped === "cancelled"
          ? "TypeScript execution cancelled"
          : `TypeScript execution timed out after ${this.options.timeoutMs}ms`,
    });
  }

  #interrupt(): boolean {
    try {
      return this.addon.interruptQueuedJavascript?.(this.id) === true;
    } catch {
      // Native timeout interruption remains a bounded fallback if explicit cancellation fails.
      return false;
    }
  }
}

export function createWasmtimeFunctionExecutor({
  addon,
  component,
}: WasmtimeFunctionExecutorOptions): FunctionExecutor {
  return {
    async execute(program, handler: CapabilityHandler, options): Promise<unknown> {
      if (options.signal?.aborted) {
        throw terminationError("cancelled", "TypeScript execution cancelled");
      }
      const execution = new GuestExecution(addon, handler, program.effects, options);
      const source = createWasmtimeGuestSource(program, options.input);
      execution.signal.addEventListener("abort", execution.stop, { once: true });
      try {
        await addon.executeQueuedJavascript(
          component,
          source,
          execution.handle,
          DEFAULT_FUEL,
          options.timeoutMs,
          options.memoryLimitMb,
          execution.id,
        );
      } catch (error) {
        throw execution.failure(error);
      } finally {
        execution.signal.removeEventListener("abort", execution.stop);
      }
      // With no pending host work, the guest can only finish early by awaiting a promise that
      // nothing will settle; report that immediately instead of waiting for the deadline.
      if (!execution.resultReceived) {
        throw new Error(
          "TypeScript program finished without a result: it awaited a promise that never settles",
        );
      }
      return execution.result;
    },
  };
}
