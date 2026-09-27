import type { FunctionScope } from "../functions/core.js";
import { clipText } from "../shared/bounds.js";

export type HostCallTraceStatus = "running" | "succeeded" | "failed" | "rejected";

export interface HostCallArgumentSummary {
  type: "null" | "string" | "number" | "boolean" | "array" | "object" | "other";
  size?: number;
}

export type FunctionExecutionScope = FunctionScope;

export interface FunctionExecutionContext {
  invocationId: number;
  parentInvocationId?: number;
  name: string;
  scope: FunctionExecutionScope;
  depth: number;
}

export interface HostCallTrace {
  id: number;
  sequence: number;
  namespace: string;
  method: string;
  arguments: HostCallArgumentSummary[];
  argumentsTruncated?: true;
  startedAt: number;
  durationMs?: number;
  status: HostCallTraceStatus;
  function?: FunctionExecutionContext;
}

export interface HostCallTraceSnapshot {
  traces: HostCallTrace[];
  truncated: boolean;
}

export const MAX_RETAINED_HOST_CALL_TRACES = 128;

export class HostCallTraceCollector {
  readonly #limit: number;
  readonly #traces = new Map<number, HostCallTrace>();
  #truncated = false;

  constructor(limit = MAX_RETAINED_HOST_CALL_TRACES) {
    this.#limit = Math.max(1, limit);
  }

  record(trace: HostCallTrace): void {
    if (this.#traces.has(trace.sequence)) {
      this.#traces.set(trace.sequence, trace);
      return;
    }
    if (this.#traces.size >= this.#limit) {
      this.#truncated = true;
      return;
    }
    this.#traces.set(trace.sequence, trace);
  }

  snapshot(): HostCallTraceSnapshot {
    return {
      traces: [...this.#traces.values()].sort((left, right) => left.sequence - right.sequence),
      truncated: this.#truncated,
    };
  }
}

const MAX_TRACE_NAME_CHARS = 80;
const MAX_TRACE_ARGUMENTS = 8;

function boundedName(value: string): string {
  return clipText(value, MAX_TRACE_NAME_CHARS);
}

function argumentSummary(value: unknown): HostCallArgumentSummary {
  if (value === null) {
    return { type: "null" };
  }
  if (typeof value === "string") {
    return { type: "string", size: value.length };
  }
  if (typeof value === "number") {
    return { type: "number" };
  }
  if (typeof value === "boolean") {
    return { type: "boolean" };
  }
  if (Array.isArray(value)) {
    return { type: "array", size: value.length };
  }
  if (typeof value === "object") {
    return { type: "object", size: Object.keys(value).length };
  }
  return { type: "other" };
}

export interface StartHostCallTraceInput {
  id: number;
  sequence: number;
  namespace: string;
  method: string;
  args: unknown[];
  startedAt?: number;
  functionContext?: FunctionExecutionContext;
}

export function startHostCallTrace({
  id,
  sequence,
  namespace,
  method,
  args,
  startedAt = Date.now(),
  functionContext,
}: StartHostCallTraceInput): HostCallTrace {
  return {
    id,
    sequence,
    namespace: boundedName(namespace),
    method: boundedName(method),
    arguments: args.slice(0, MAX_TRACE_ARGUMENTS).map(argumentSummary),
    ...(args.length > MAX_TRACE_ARGUMENTS ? { argumentsTruncated: true as const } : {}),
    startedAt,
    status: "running",
    ...(functionContext
      ? { function: { ...functionContext, name: boundedName(functionContext.name) } }
      : {}),
  };
}

export function finishHostCallTrace(
  trace: HostCallTrace,
  status: Exclude<HostCallTraceStatus, "running">,
  finishedAt = Date.now(),
): HostCallTrace {
  return {
    ...trace,
    durationMs: Math.max(0, finishedAt - trace.startedAt),
    status,
  };
}
