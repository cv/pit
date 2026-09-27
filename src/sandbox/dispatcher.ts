import {
  type HostCallTrace,
  type FunctionExecutionContext,
  finishHostCallTrace,
  startHostCallTrace,
} from "../execution/host-call-trace.js";
import type { HostCallMessage, WireMessage } from "./wire.js";

export interface HostCallRequest {
  namespace: string;
  method: string;
  args: unknown[];
  signal: AbortSignal;
  functionContext?: FunctionExecutionContext;
  /** Host-assigned identity, never supplied by guest code. */
  traceSequence?: number;
}

export type HostCallHandler = (request: HostCallRequest) => unknown | Promise<unknown>;

interface HostCallDispatcherOptions {
  handler: HostCallHandler;
  signal: AbortSignal;
  maximumCalls: number;
  maximumConcurrentCalls: number;
  allowedCalls?: ReadonlySet<string>;
  send(message: WireMessage): boolean;
  parseFunctionContext(value: unknown): FunctionExecutionContext | undefined;
  onTrace?(trace: HostCallTrace): void;
}

export class HostCallDispatcher {
  readonly #inFlight = new Set<Promise<void>>();
  #callCount = 0;
  #activeCalls = 0;

  constructor(private readonly options: HostCallDispatcherOptions) {}

  pending(): Promise<void>[] {
    return [...this.#inFlight];
  }

  handle(message: HostCallMessage): void {
    const { id, namespace, method, args } = message;
    this.#callCount++;
    const functionContext = this.options.parseFunctionContext(message.functionContext);
    const trace = startHostCallTrace({
      id,
      sequence: this.#callCount,
      namespace,
      method,
      args,
      startedAt: Date.now(),
      ...(functionContext ? { functionContext } : {}),
    });
    this.#report(trace);
    const finishTrace = (status: "succeeded" | "failed" | "rejected") =>
      this.#report(finishHostCallTrace(trace, status));

    const call = `${namespace}.${method}`;
    if (
      namespace !== "__pit" &&
      this.options.allowedCalls &&
      !this.options.allowedCalls.has(call)
    ) {
      this.options.send({
        type: "response",
        id,
        error: `Function grant does not allow ${call}`,
      });
      finishTrace("rejected");
      return;
    }

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
          namespace,
          method,
          args,
          signal: this.options.signal,
          traceSequence: trace.sequence,
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
              error: "Host call response exceeds RPC limit",
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
            ...(error instanceof Error && error.name !== "Error"
              ? { errorName: error.name.slice(0, 100) }
              : {}),
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

  #report(trace: HostCallTrace): void {
    try {
      this.options.onTrace?.(trace);
    } catch {
      // Tracing is observational and must not affect host-call execution.
    }
  }
}
