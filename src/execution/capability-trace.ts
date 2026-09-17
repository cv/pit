import type { FunctionScope } from "../functions/core.js";

export type CapabilityTraceStatus = "running" | "succeeded" | "failed" | "rejected";

export interface CapabilityArgumentSummary {
  type: "null" | "string" | "number" | "boolean" | "array" | "object" | "other";
  size?: number;
}

export type FunctionExecutionScope = FunctionScope | "user";

export interface FunctionExecutionContext {
  invocationId: number;
  parentInvocationId?: number;
  name: string;
  scope: FunctionExecutionScope;
  depth: number;
}

export interface CapabilityTrace {
  id: number;
  sequence: number;
  capability: string;
  method: string;
  arguments: CapabilityArgumentSummary[];
  argumentsTruncated?: true;
  startedAt: number;
  durationMs?: number;
  status: CapabilityTraceStatus;
  function?: FunctionExecutionContext;
}

export interface CapabilityTraceSnapshot {
  traces: CapabilityTrace[];
  truncated: boolean;
}

export const MAX_RETAINED_CAPABILITY_TRACES = 128;

export class CapabilityTraceCollector {
  readonly #limit: number;
  readonly #traces = new Map<number, CapabilityTrace>();
  #truncated = false;

  constructor(limit = MAX_RETAINED_CAPABILITY_TRACES) {
    this.#limit = Math.max(1, limit);
  }

  record(trace: CapabilityTrace): void {
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

  snapshot(): CapabilityTraceSnapshot {
    return {
      traces: [...this.#traces.values()].sort((left, right) => left.sequence - right.sequence),
      truncated: this.#truncated,
    };
  }
}

const MAX_TRACE_NAME_CHARS = 80;
const MAX_TRACE_ARGUMENTS = 8;

function boundedName(value: string): string {
  return value.length <= MAX_TRACE_NAME_CHARS
    ? value
    : `${value.slice(0, MAX_TRACE_NAME_CHARS - 1)}…`;
}

function argumentSummary(value: unknown): CapabilityArgumentSummary {
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

export interface StartCapabilityTraceInput {
  id: number;
  sequence: number;
  capability: string;
  method: string;
  args: unknown[];
  startedAt?: number;
  functionContext?: FunctionExecutionContext;
}

export function startCapabilityTrace({
  id,
  sequence,
  capability,
  method,
  args,
  startedAt = Date.now(),
  functionContext,
}: StartCapabilityTraceInput): CapabilityTrace {
  return {
    id,
    sequence,
    capability: boundedName(capability),
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

export function finishCapabilityTrace(
  trace: CapabilityTrace,
  status: Exclude<CapabilityTraceStatus, "running">,
  finishedAt = Date.now(),
): CapabilityTrace {
  return {
    ...trace,
    durationMs: Math.max(0, finishedAt - trace.startedAt),
    status,
  };
}
