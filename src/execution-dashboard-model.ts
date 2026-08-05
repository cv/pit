import type { CapabilityTrace, CapabilityTraceStatus } from "./capability-trace.js";
import type { ExecutionProgressSnapshot } from "./execution-types.js";
import type { FunctionActivity, FunctionScope } from "./saved-functions.js";

interface ExecutionDashboardDetails extends ExecutionProgressSnapshot {
  functions?: FunctionActivity[];
}

interface CapabilityTraceGroup {
  sequence: number;
  traces: [CapabilityTrace, ...CapabilityTrace[]];
}

export interface DashboardActivity {
  scope: FunctionScope;
  name: string;
}

export interface DashboardCall {
  kind: "call";
  capability: string;
  method: string;
  status: CapabilityTraceStatus;
  summary: string;
}

export interface DashboardFunction {
  kind: "function";
  id: number;
  scope: FunctionScope;
  name: string;
  events: DashboardEvent[];
}

export type DashboardEvent = DashboardCall | DashboardFunction;

export interface ExecutionDashboardModel {
  activities: DashboardActivity[];
  events: DashboardEvent[];
  tracesTruncated: boolean;
}

function failedTrace(trace: CapabilityTrace): boolean {
  return trace.status === "failed" || trace.status === "rejected";
}

function sameTraceGroup(left: CapabilityTrace, right: CapabilityTrace): boolean {
  return (
    !(failedTrace(left) || failedTrace(right)) &&
    left.capability === right.capability &&
    left.method === right.method &&
    left.function?.invocationId === right.function?.invocationId
  );
}

function groupAdjacentTraces(traces: CapabilityTrace[]): CapabilityTraceGroup[] {
  const groups: CapabilityTraceGroup[] = [];
  for (const trace of traces) {
    const previous = groups.at(-1);
    const previousTrace = previous?.traces.at(-1);
    if (previous && previousTrace && sameTraceGroup(previousTrace, trace)) {
      previous.traces.push(trace);
    } else {
      groups.push({ sequence: trace.sequence, traces: [trace] });
    }
  }
  return groups;
}

function traceGroupStatus(group: CapabilityTraceGroup): CapabilityTraceStatus {
  const statuses = new Set(group.traces.map((trace) => trace.status));
  if (statuses.has("failed")) {
    return "failed";
  }
  if (statuses.has("rejected")) {
    return "rejected";
  }
  if (statuses.has("running")) {
    return "running";
  }
  return "succeeded";
}

function traceGroupSummary(group: CapabilityTraceGroup, now: number): string {
  if (group.traces.length === 1) {
    const trace = group.traces[0];
    return `${trace.status}, ${((trace.durationMs ?? Math.max(0, now - trace.startedAt)) / 1000).toFixed(1)}s`;
  }
  const statuses = new Map<CapabilityTraceStatus, number>();
  for (const trace of group.traces) {
    statuses.set(trace.status, (statuses.get(trace.status) ?? 0) + 1);
  }
  const status =
    statuses.size === 1
      ? `${group.traces[0].status} ×${group.traces.length}`
      : [...statuses].map(([name, count]) => `${count} ${name}`).join(", ");
  const startedAt = group.traces[0].startedAt;
  const finishedAt = Math.max(
    ...group.traces.map((trace) => trace.startedAt + (trace.durationMs ?? now - trace.startedAt)),
  );
  return `${status} over ${(Math.max(0, finishedAt - startedAt) / 1000).toFixed(1)}s`;
}

function callModel(group: CapabilityTraceGroup, now: number): DashboardCall {
  const trace = group.traces.at(-1) as CapabilityTrace;
  return {
    kind: "call",
    capability: trace.capability,
    method: trace.method,
    status: traceGroupStatus(group),
    summary: traceGroupSummary(group, now),
  };
}

export function buildExecutionDashboardModel(
  details: ExecutionDashboardDetails | undefined,
  now = Date.now(),
): ExecutionDashboardModel {
  const traceEntries = details?.traces ?? [];
  const recent = groupAdjacentTraces(traceEntries).slice(-12);
  const contexts = new Map(
    traceEntries.flatMap((trace) =>
      trace.function ? [[trace.function.invocationId, trace.function] as const] : [],
    ),
  );
  const firstSequence = new Map<number, number>();
  for (const trace of traceEntries) {
    if (trace.function && !firstSequence.has(trace.function.invocationId)) {
      firstSequence.set(trace.function.invocationId, trace.sequence);
    }
  }
  const involved = new Set<number>();
  for (const group of recent) {
    let current = group.traces.at(-1)?.function;
    while (current && !involved.has(current.invocationId)) {
      involved.add(current.invocationId);
      current = current.parentInvocationId ? contexts.get(current.parentInvocationId) : undefined;
    }
  }

  const attributedActivities = new Set(
    [...contexts.values()].map((context) => `${context.scope}:${context.name}`),
  );
  const activities = (details?.functions ?? [])
    .filter((entry) => entry.action === "run")
    .filter((entry) => !attributedActivities.has(`${entry.scope ?? "session"}:${entry.name}`))
    .slice(-4)
    .map((entry) => ({ scope: entry.scope ?? ("session" as const), name: entry.name }));

  const callsByInvocation = new Map<number, CapabilityTraceGroup[]>();
  const rootCalls: CapabilityTraceGroup[] = [];
  for (const group of recent) {
    const trace = group.traces.at(-1);
    if (!trace || trace.capability === "__pit") {
      continue;
    }
    if (trace.function) {
      const calls = callsByInvocation.get(trace.function.invocationId) ?? [];
      calls.push(group);
      callsByInvocation.set(trace.function.invocationId, calls);
    } else {
      rootCalls.push(group);
    }
  }
  const children = new Map<number, number[]>();
  const roots: number[] = [];
  for (const id of involved) {
    const parent = contexts.get(id)?.parentInvocationId;
    if (parent && involved.has(parent)) {
      const ids = children.get(parent) ?? [];
      ids.push(id);
      children.set(parent, ids);
    } else {
      roots.push(id);
    }
  }
  const sequenceFor = (id: number) => firstSequence.get(id) ?? Number.MAX_SAFE_INTEGER;
  roots.sort((left, right) => sequenceFor(left) - sequenceFor(right));
  for (const ids of children.values()) {
    ids.sort((left, right) => sequenceFor(left) - sequenceFor(right));
  }

  const rendered = new Set<number>();
  const buildFunction = (id: number): DashboardFunction | undefined => {
    if (rendered.has(id)) {
      return;
    }
    rendered.add(id);
    const context = contexts.get(id);
    if (!context) {
      return;
    }
    const ordered = [
      ...(callsByInvocation.get(id) ?? []).map((group) => ({ sequence: group.sequence, group })),
      ...(children.get(id) ?? []).map((childId) => ({ sequence: sequenceFor(childId), childId })),
    ].sort((left, right) => left.sequence - right.sequence);
    const events = ordered.flatMap((event): DashboardEvent[] => {
      if ("group" in event) {
        return [callModel(event.group, now)];
      }
      const child = buildFunction(event.childId);
      return child ? [child] : [];
    });
    return { kind: "function", id, scope: context.scope, name: context.name, events };
  };
  const rootEvents = [
    ...rootCalls.map((group) => ({ sequence: group.sequence, group })),
    ...roots.map((id) => ({ sequence: sequenceFor(id), invocationId: id })),
  ].sort((left, right) => left.sequence - right.sequence);
  const events = rootEvents.flatMap((event): DashboardEvent[] => {
    if ("group" in event) {
      return [callModel(event.group, now)];
    }
    const invocation = buildFunction(event.invocationId);
    return invocation ? [invocation] : [];
  });
  return { activities, events, tracesTruncated: details?.tracesTruncated === true };
}
