import { setTimeout as delay } from "node:timers/promises";

import {
  CodemodeSandbox,
  type CodemodeError,
  type CodemodeResult,
} from "@earendil-works/pi-codemode";

import { isRecord } from "../shared/records.js";
import { terminationError } from "../shared/termination-errors.js";
import { HostCallDispatcher, type HostCallHandler } from "./dispatcher.js";
import {
  parseFunctionExecutionContext,
  type FunctionExecutionOptions,
  type FunctionExecutor,
} from "./executor.js";
import { createGuestSource } from "./guest-source.js";
import type { HostCallMessage, WireMessage } from "./wire.js";
import { isHostCallMessage } from "./wire.js";

const MAX_PROTOCOL_FRAME_BYTES = 8_000_000;
const MAX_HOST_CALLS = 1_024;
const MAX_CONCURRENT_HOST_CALLS = 32;
const EMPTY_RESPONSE = JSON.stringify({ value: null });
const NO_RESULT =
  "TypeScript program finished without a result: it awaited a promise that never settles";

/**
 * Runs one guest script with Pit's bridge as its `pitCall` global, until it settles or the signal
 * aborts it. Each execution gets its own worker thread and QuickJS VM; the compiled Wasm is shared.
 */
async function runInCodemodeSandbox(
  source: string,
  bridge: (request: string) => Promise<string>,
  options: { memoryLimitMb: number; signal: AbortSignal },
): Promise<CodemodeResult> {
  const sandbox = new CodemodeSandbox({
    globals: [{ name: "pitCall", execute: (request) => bridge(String(request)) }],
    memoryLimitBytes: options.memoryLimitMb * 1024 * 1024,
    // Pit's signal carries the deadline, so a stop can be told apart from a cancellation.
    timeoutMs: Number.POSITIVE_INFINITY,
  });
  try {
    return await sandbox.execute(source, { signal: options.signal });
  } finally {
    await sandbox.close();
  }
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

function executionSignal(options: FunctionExecutionOptions, failed: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  return AbortSignal.any([...(options.signal ? [options.signal] : []), timeout, failed]);
}

/** Parses one bounded guest request into a plain object. */
function parseGuestRequest(raw: string): Record<string, unknown> {
  if (Buffer.byteLength(raw) > MAX_PROTOCOL_FRAME_BYTES) {
    throw new Error("Pit guest request exceeds bounds");
  }
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value)) {
    throw new Error("Invalid Pit guest request");
  }
  return value;
}

/**
 * The host side of one execution: answers guest requests, dispatches host calls, stops the
 * guest at the deadline or on cancellation, and classifies how a failed execution ended.
 */
class GuestExecution {
  readonly signal: AbortSignal;
  resultReceived = false;
  result: unknown;
  readonly #waiters = new Map<number, { effect: string; resolve: (response: string) => void }>();
  // Calls a stop answered while they were still running; their effects may have started.
  #stillRunning: string[] = [];
  readonly #dispatcher: HostCallDispatcher;
  #stopped: "timeout" | "cancelled" | undefined;
  // A request the bridge rejected ends the execution, even if the program catches the rejection.
  readonly #protocol = new AbortController();
  protocolError: Error | undefined;

  private readonly options: FunctionExecutionOptions;

  constructor(
    handler: HostCallHandler,
    effects: Iterable<string>,
    options: FunctionExecutionOptions,
  ) {
    this.options = options;
    this.signal = executionSignal(options, this.#protocol.signal);
    this.#dispatcher = new HostCallDispatcher({
      handler,
      signal: this.signal,
      maximumCalls: MAX_HOST_CALLS,
      maximumConcurrentCalls: MAX_CONCURRENT_HOST_CALLS,
      allowedCalls: new Set(effects),
      parseFunctionContext: parseFunctionExecutionContext,
      send: (message) => this.#reply(message),
      ...(options.onHostCallTrace ? { onTrace: options.onHostCallTrace } : {}),
    });
  }

  /** Answers one guest request. The sandbox calls this for every `pitCall()` the guest makes. */
  readonly handle = async (raw: string): Promise<string> => {
    try {
      return await this.#answer(raw);
    } catch (error) {
      // Bridge failures are parse errors and Pit's own errors, never other thrown values.
      this.protocolError ??= error as Error;
      this.#protocol.abort(this.protocolError);
      throw error;
    }
  };

  async #answer(raw: string): Promise<string> {
    const request = parseGuestRequest(raw);
    if (isTimerRequest(request)) return this.#wait(request.delayMs);
    const message = request as WireMessage;
    if (message.type === "result") {
      this.resultReceived = true;
      this.result = message.value;
      return EMPTY_RESPONSE;
    }
    if (!isHostCallMessage(message)) throw new Error("Invalid Pit guest request");
    return this.#call(message);
  }

  /**
   * The deadline holds even when a host handler ignores its abort signal: the sandbox ends the
   * guest on the same signal, and every waiting call is answered and named in the error.
   */
  readonly stop = (): void => {
    this.#stopped = this.options.signal?.aborted ? "cancelled" : "timeout";
    this.#stillRunning = [...this.#waiters.values()].map((waiter) => waiter.effect);
    for (const [id, waiter] of this.#waiters) waiter.resolve(this.#stoppedResponse(id));
    this.#waiters.clear();
  };

  /** The error to report for a failed execution. */
  failure(error: CodemodeError): Error {
    if (this.options.signal?.aborted) {
      return terminationError("cancelled", `TypeScript execution cancelled${this.#runningNote()}`);
    }
    // The sandbox ends the guest only when this execution's signal stops it; a guest that
    // failed on its own keeps its error even if the budget also elapsed.
    if (error.kind === "timeout" || (error.kind === "aborted" && this.#stopped === "timeout")) {
      return terminationError(
        "timeout",
        `TypeScript execution timed out after ${this.options.timeoutMs}ms${this.#runningNote()}`,
      );
    }
    // With no host call or timer pending, a guest awaiting an unsettled promise cannot resume.
    if (/can never settle/i.test(error.message)) return new Error(NO_RESULT);
    // The sandbox reports the guest's own error name and message, without its stack.
    const failure = new Error(error.message);
    if (error.name && error.name !== "Error") failure.name = error.name;
    return failure;
  }

  /**
   * Waits for host calls the program started but did not await: the sandbox drops them when the
   * script ends, but their effects still run, so success waits for them within the deadline.
   */
  async settle(): Promise<void> {
    const stopped = new Promise<void>((resolve) => {
      this.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    let calls = this.#dispatcher.pending();
    while (calls.length > 0 && !this.signal.aborted) {
      await Promise.race([Promise.allSettled(calls), stopped]);
      calls = this.#dispatcher.pending();
    }
  }

  #call(message: HostCallMessage): Promise<string> {
    // After the deadline or cancellation, the dispatcher answers without calling a handler.
    return new Promise<string>((resolve) => {
      this.#waiters.set(message.id, { effect: `${message.namespace}.${message.method}`, resolve });
      this.#dispatcher.handle(message);
    });
  }

  #runningNote(): string {
    const count = this.#stillRunning.length;
    if (count === 0) return "";
    const calls = count === 1 ? "call was" : "calls were";
    return ` while ${count} host ${calls} still running: ${[...new Set(this.#stillRunning)].join(", ")}`;
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
    if (!waiter) return false;
    const response = JSON.stringify(message);
    /* v8 ignore next -- dispatcher sends a bounded fallback after rejection. */
    if (Buffer.byteLength(response) > MAX_PROTOCOL_FRAME_BYTES) return false;
    this.#waiters.delete(message.id);
    waiter.resolve(response);
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
}

/** Pit's executor: each program runs in a fresh QuickJS VM in Pi's codemode sandbox. */
export function createCodemodeFunctionExecutor(): FunctionExecutor {
  return {
    async execute(program, handler: HostCallHandler, options): Promise<unknown> {
      if (options.signal?.aborted) {
        throw terminationError("cancelled", "TypeScript execution cancelled");
      }
      const execution = new GuestExecution(handler, program.effects, options);
      execution.signal.addEventListener("abort", execution.stop, { once: true });
      let result: CodemodeResult;
      try {
        result = await runInCodemodeSandbox(
          createGuestSource(program, options.input),
          execution.handle,
          {
            memoryLimitMb: options.memoryLimitMb,
            signal: execution.signal,
          },
        );
        if (result.ok) await execution.settle();
      } finally {
        execution.signal.removeEventListener("abort", execution.stop);
      }
      if (execution.protocolError) throw execution.protocolError;
      if (!result.ok) throw execution.failure(result.error);
      if (execution.signal.aborted) {
        throw execution.failure({ kind: "aborted", message: "stopped while host calls ran" });
      }
      // A guest that ended without reporting a value, for example through the sandbox's exit().
      if (!execution.resultReceived) throw new Error(NO_RESULT);
      return execution.result;
    },
  };
}
