import type { FunctionActivity, FunctionScope } from "../functions/core.js";
import type {
  CapabilityTrace,
  CapabilityTraceStatus,
  FunctionExecutionScope,
} from "./capability-trace.js";
import type { ExecutionProgressSnapshot } from "./types.js";

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
  scope: FunctionExecutionScope;
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

type FunctionTraceContext = NonNullable<CapabilityTrace["function"]>;

interface TraceFunctionIndex {
  contexts: Map<number, FunctionTraceContext>;
  firstSequence: Map<number, number>;
}

interface GroupedDashboardCalls {
  byInvocation: Map<number, CapabilityTraceGroup[]>;
  root: CapabilityTraceGroup[];
}

interface InvocationTree {
  children: Map<number, number[]>;
  roots: number[];
}

interface OrderedCall {
  sequence: number;
  group: CapabilityTraceGroup;
}

interface OrderedInvocation {
  sequence: number;
  invocationId: number;
}

type OrderedDashboardEntry = OrderedCall | OrderedInvocation;

interface DashboardEventBuilder {
  calls: GroupedDashboardCalls;
  contexts: Map<number, FunctionTraceContext>;
  firstSequence: Map<number, number>;
  tree: InvocationTree;
  rendered: Set<number>;
  now: number;
}

function indexTraceFunctions(traces: CapabilityTrace[]): TraceFunctionIndex {
  const contexts = new Map<number, FunctionTraceContext>();
  const firstSequence = new Map<number, number>();
  for (const trace of traces) {
    if (!trace.function) {
      continue;
    }
    contexts.set(trace.function.invocationId, trace.function);
    if (!firstSequence.has(trace.function.invocationId)) {
      firstSequence.set(trace.function.invocationId, trace.sequence);
    }
  }
  return { contexts, firstSequence };
}

function findInvolvedInvocations(
  groups: CapabilityTraceGroup[],
  contexts: Map<number, FunctionTraceContext>,
): Set<number> {
  const involved = new Set<number>();
  for (const group of groups) {
    let current = group.traces.at(-1)?.function;
    while (current && !involved.has(current.invocationId)) {
      involved.add(current.invocationId);
      current = current.parentInvocationId ? contexts.get(current.parentInvocationId) : undefined;
    }
  }
  return involved;
}

function findUnattributedActivities(
  functions: FunctionActivity[],
  contexts: Map<number, FunctionTraceContext>,
): DashboardActivity[] {
  const attributed = new Set(
    [...contexts.values()].map((context) => `${context.scope}:${context.name}`),
  );
  return functions
    .filter((entry) => entry.action === "run")
    .filter((entry) => !attributed.has(`${entry.scope ?? "session"}:${entry.name}`))
    .map((entry) => ({ scope: entry.scope ?? "session", name: entry.name }));
}

function groupDashboardCalls(groups: CapabilityTraceGroup[]): GroupedDashboardCalls {
  const byInvocation = new Map<number, CapabilityTraceGroup[]>();
  const root: CapabilityTraceGroup[] = [];
  for (const group of groups) {
    const trace = group.traces.at(-1);
    if (!trace || trace.capability === "__pit") {
      continue;
    }
    if (!trace.function) {
      root.push(group);
      continue;
    }
    const calls = byInvocation.get(trace.function.invocationId) ?? [];
    calls.push(group);
    byInvocation.set(trace.function.invocationId, calls);
  }
  return { byInvocation, root };
}

function sequenceFor(id: number, firstSequence: Map<number, number>): number {
  return firstSequence.get(id) ?? Number.MAX_SAFE_INTEGER;
}

function buildInvocationTree(
  involved: Set<number>,
  contexts: Map<number, FunctionTraceContext>,
  firstSequence: Map<number, number>,
): InvocationTree {
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
  const compareSequence = (left: number, right: number) =>
    sequenceFor(left, firstSequence) - sequenceFor(right, firstSequence);
  roots.sort(compareSequence);
  for (const ids of children.values()) {
    ids.sort(compareSequence);
  }
  return { children, roots };
}

function invocationEntries(id: number, builder: DashboardEventBuilder): OrderedDashboardEntry[] {
  return [
    ...(builder.calls.byInvocation.get(id) ?? []).map((group) => ({
      sequence: group.sequence,
      group,
    })),
    ...(builder.tree.children.get(id) ?? []).map((invocationId) => ({
      sequence: sequenceFor(invocationId, builder.firstSequence),
      invocationId,
    })),
  ].sort((left, right) => left.sequence - right.sequence);
}

function buildFunctionEvent(
  id: number,
  builder: DashboardEventBuilder,
): DashboardFunction | undefined {
  if (builder.rendered.has(id)) {
    return;
  }
  builder.rendered.add(id);
  const context = builder.contexts.get(id);
  if (!context) {
    return;
  }
  return {
    kind: "function",
    id,
    scope: context.scope,
    name: context.name,
    events: buildOrderedEvents(invocationEntries(id, builder), builder),
  };
}

function buildOrderedEvents(
  entries: OrderedDashboardEntry[],
  builder: DashboardEventBuilder,
): DashboardEvent[] {
  return entries.flatMap((entry): DashboardEvent[] => {
    if ("group" in entry) {
      return [callModel(entry.group, builder.now)];
    }
    const invocation = buildFunctionEvent(entry.invocationId, builder);
    return invocation ? [invocation] : [];
  });
}

function buildDashboardEvents(
  calls: GroupedDashboardCalls,
  tree: InvocationTree,
  index: TraceFunctionIndex,
  now: number,
): DashboardEvent[] {
  const builder: DashboardEventBuilder = {
    calls,
    contexts: index.contexts,
    firstSequence: index.firstSequence,
    tree,
    rendered: new Set(),
    now,
  };
  const entries: OrderedDashboardEntry[] = [
    ...calls.root.map((group) => ({ sequence: group.sequence, group })),
    ...tree.roots.map((invocationId) => ({
      sequence: sequenceFor(invocationId, index.firstSequence),
      invocationId,
    })),
  ].sort((left, right) => left.sequence - right.sequence);
  return buildOrderedEvents(entries, builder);
}

export function buildExecutionDashboardModel(
  details: ExecutionDashboardDetails | undefined,
  now = Date.now(),
): ExecutionDashboardModel {
  const traces = details?.traces ?? [];
  const recent = groupAdjacentTraces(traces);
  const index = indexTraceFunctions(traces);
  const involved = findInvolvedInvocations(recent, index.contexts);
  const calls = groupDashboardCalls(recent);
  const tree = buildInvocationTree(involved, index.contexts, index.firstSequence);
  return {
    activities: findUnattributedActivities(details?.functions ?? [], index.contexts),
    events: buildDashboardEvents(calls, tree, index, now),
    tracesTruncated: details?.tracesTruncated === true,
  };
}
