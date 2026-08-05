import {
  type CapabilityTrace,
  type FunctionExecutionContext,
  finishCapabilityTrace,
  startCapabilityTrace,
} from "./capability-trace.js";
import type { CapabilityCallMessage, WireMessage } from "./sandbox-wire.js";

export interface CapabilityRequest {
  capability: string;
  method: string;
  args: unknown[];
  signal: AbortSignal;
  functionContext?: FunctionExecutionContext;
}

export type CapabilityHandler = (request: CapabilityRequest) => unknown | Promise<unknown>;

interface CapabilityDispatcherOptions {
  handler: CapabilityHandler;
  signal: AbortSignal;
  maximumCalls: number;
  maximumConcurrentCalls: number;
  send(message: WireMessage): boolean;
  parseFunctionContext(value: unknown): FunctionExecutionContext | undefined;
  onTrace?(trace: CapabilityTrace): void;
}

export class CapabilityDispatcher {
  readonly #inFlight = new Set<Promise<void>>();
  #callCount = 0;
  #activeCalls = 0;

  constructor(private readonly options: CapabilityDispatcherOptions) {}

  pending(): Promise<void>[] {
    return [...this.#inFlight];
  }

  handle(message: CapabilityCallMessage): void {
    const { id, capability, method, args } = message;
    this.#callCount++;
    const functionContext = this.options.parseFunctionContext(message.functionContext);
    const trace = startCapabilityTrace({
      id,
      sequence: this.#callCount,
      capability,
      method,
      args,
      startedAt: Date.now(),
      ...(functionContext ? { functionContext } : {}),
    });
    this.#report(trace);
    const finishTrace = (status: "succeeded" | "failed" | "rejected") =>
      this.#report(finishCapabilityTrace(trace, status));

    if (this.#callCount > this.options.maximumCalls) {
      this.options.send({
        type: "response",
        id,
        error: `RPC call limit exceeded (${this.options.maximumCalls})`,
      });
      finishTrace("rejected");
      return;
    }
    if (this.#activeCalls >= this.options.maximumConcurrentCalls) {
      this.options.send({
        type: "response",
        id,
        error: `Concurrent RPC call limit exceeded (${this.options.maximumConcurrentCalls})`,
      });
      finishTrace("rejected");
      return;
    }

    this.#activeCalls++;
    let task: Promise<void>;
    task = Promise.resolve()
      .then(() =>
        this.options.handler({
          capability,
          method,
          args,
          signal: this.options.signal,
          ...(trace.function ? { functionContext: trace.function } : {}),
        }),
      )
      .then(
        (value) => {
          if (this.options.send({ type: "response", id, value })) {
            finishTrace("succeeded");
          } else {
            this.options.send({
              type: "response",
              id,
              error: "Capability response exceeds RPC limit",
            });
            finishTrace("failed");
          }
          return undefined;
        },
        (error) => {
          this.options.send({
            type: "response",
            id,
            error: error instanceof Error ? error.message : String(error),
          });
          finishTrace("failed");
          return undefined;
        },
      )
      .finally(() => {
        this.#activeCalls--;
        this.#inFlight.delete(task);
      });
    this.#inFlight.add(task);
  }

  #report(trace: CapabilityTrace): void {
    try {
      this.options.onTrace?.(trace);
    } catch {
      // Tracing is observational and must not affect capability execution.
    }
  }
}
