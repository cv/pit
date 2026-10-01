import type { FunctionActivity, FunctionScope } from "../functions/core.js";
import type {
  HostCallTrace,
  HostCallTraceStatus,
  FunctionExecutionScope,
} from "./host-call-trace.js";
import type { ExecutionProgressSnapshot } from "./types.js";

interface ExecutionDashboardDetails extends ExecutionProgressSnapshot {
  functions?: FunctionActivity[];
}

interface HostCallTraceGroup {
  sequence: number;
  traces: [HostCallTrace, ...HostCallTrace[]];
}

export interface DashboardActivity {
  scope: FunctionScope;
  name: string;
}

export interface DashboardStatusCount {
  status: HostCallTraceStatus;
  count: number;
}

export interface DashboardCall {
  kind: "call";
  sequences: number[];
  namespace: string;
  method: string;
  /** Aggregate status, prioritizing failed, rejected, then running calls. */
  status: HostCallTraceStatus;
  /** Calls in this group. */
  count: number;
  /** Calls per status in first-seen order. */
  statuses: DashboardStatusCount[];
  /** Span from the first start to the last finish; unfinished calls are measured to `now`. */
  durationMs: number;
  /** Whether any call in the group has no recorded finish. */
  unfinished: boolean;
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

function failedTrace(trace: HostCallTrace): boolean {
  return trace.status === "failed" || trace.status === "rejected";
}

function sameTraceGroup(left: HostCallTrace, right: HostCallTrace): boolean {
  return (
    !(failedTrace(left) || failedTrace(right)) &&
    left.namespace === right.namespace &&
    left.method === right.method &&
    left.function?.invocationId === right.function?.invocationId
  );
}

function groupAdjacentTraces(traces: HostCallTrace[], linked: Set<number>): HostCallTraceGroup[] {
  const groups: HostCallTraceGroup[] = [];
  for (const trace of traces) {
    const previous = groups.at(-1);
    const previousTrace = previous?.traces.at(-1);
    if (
      previous &&
      previousTrace &&
      !linked.has(previousTrace.sequence) &&
      !linked.has(trace.sequence) &&
      sameTraceGroup(previousTrace, trace)
    ) {
      previous.traces.push(trace);
    } else {
      groups.push({ sequence: trace.sequence, traces: [trace] });
    }
  }
  return groups;
}

function traceGroupStatus(group: HostCallTraceGroup): HostCallTraceStatus {
  const statuses = new Set(group.traces.map((trace) => trace.status));
  if (statuses.has("failed")) {
    return "failed";
  }
  if (statuses.has("rejected")) {
    return "rejected";
  }
  if (statuses.has("timed out")) {
    return "timed out";
  }
  if (statuses.has("cancelled")) {
    return "cancelled";
  }
  if (statuses.has("running")) {
    return "running";
  }
  return "succeeded";
}

function traceGroupStatuses(group: HostCallTraceGroup): DashboardStatusCount[] {
  const counts = new Map<HostCallTraceStatus, number>();
  for (const trace of group.traces) {
    counts.set(trace.status, (counts.get(trace.status) ?? 0) + 1);
  }
  return [...counts].map(([status, count]) => ({ status, count }));
}

function traceGroupDurationMs(group: HostCallTraceGroup, now: number): number {
  const startedAt = group.traces[0].startedAt;
  const finishedAt = Math.max(
    ...group.traces.map((trace) => trace.startedAt + (trace.durationMs ?? now - trace.startedAt)),
  );
  return Math.max(0, finishedAt - startedAt);
}

function callModel(group: HostCallTraceGroup, now: number): DashboardCall {
  const trace = group.traces.at(-1) as HostCallTrace;
  return {
    kind: "call",
    sequences: group.traces.map((entry) => entry.sequence),
    namespace: trace.namespace,
    method: trace.method,
    status: traceGroupStatus(group),
    count: group.traces.length,
    statuses: traceGroupStatuses(group),
    durationMs: traceGroupDurationMs(group, now),
    unfinished: group.traces.some((entry) => entry.durationMs === undefined),
  };
}

type FunctionTraceContext = NonNullable<HostCallTrace["function"]>;

interface TraceFunctionIndex {
  contexts: Map<number, FunctionTraceContext>;
  firstSequence: Map<number, number>;
}

interface GroupedDashboardCalls {
  byInvocation: Map<number, HostCallTraceGroup[]>;
  root: HostCallTraceGroup[];
}

interface InvocationTree {
  children: Map<number, number[]>;
  roots: number[];
}

interface OrderedCall {
  sequence: number;
  group: HostCallTraceGroup;
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

function indexTraceFunctions(traces: HostCallTrace[]): TraceFunctionIndex {
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
  groups: HostCallTraceGroup[],
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

function groupDashboardCalls(groups: HostCallTraceGroup[]): GroupedDashboardCalls {
  const byInvocation = new Map<number, HostCallTraceGroup[]>();
  const root: HostCallTraceGroup[] = [];
  for (const group of groups) {
    const trace = group.traces.at(-1);
    if (!trace || trace.namespace === "__pit") {
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
  const linked = new Set(
    (details?.progress ?? []).flatMap((entry) =>
      entry.traceSequence === undefined ? [] : [entry.traceSequence],
    ),
  );
  const recent = groupAdjacentTraces(traces, linked);
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
