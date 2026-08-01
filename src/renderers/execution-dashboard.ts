import type { CapabilityTrace } from "../capability-trace.js";
import type { ExecutionProgressSnapshot } from "../execution-types.js";
import type { FunctionActivity } from "../saved-functions.js";

interface ExecutionDashboardDetails extends ExecutionProgressSnapshot {
  functions?: FunctionActivity[];
}

interface ExecutionDashboardTheme {
  fg(color: string, text: string): string;
}

export function renderExecutionDashboard(
  details: ExecutionDashboardDetails | undefined,
  theme: ExecutionDashboardTheme,
): string {
  let text = "";
  const traceEntries = details?.traces ?? [];
  const recent = traceEntries.slice(-12);
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
  for (const trace of recent) {
    let current = trace.function;
    while (current && !involved.has(current.invocationId)) {
      involved.add(current.invocationId);
      current = current.parentInvocationId ? contexts.get(current.parentInvocationId) : undefined;
    }
  }

  const attributedActivities = new Set(
    [...contexts.values()].map((context) => `${context.scope}:${context.name}`),
  );
  const activities = details?.functions;
  for (const activity of activities
    ? activities
        .filter((entry) => entry.action === "run")
        .filter((entry) => !attributedActivities.has(`${entry.scope ?? "session"}:${entry.name}`))
        .slice(-4)
    : []) {
    const scope = activity.scope ?? "session";
    text += `\n${theme.fg("accent", "↳")} ${theme.fg("toolTitle", `${scope} function`)} ${activity.name}`;
  }

  const callsByInvocation = new Map<number, CapabilityTrace[]>();
  const rootCalls: CapabilityTrace[] = [];
  for (const trace of recent) {
    if (trace.capability === "__pit") {
      continue;
    }
    if (trace.function) {
      const calls = callsByInvocation.get(trace.function.invocationId) ?? [];
      calls.push(trace);
      callsByInvocation.set(trace.function.invocationId, calls);
    } else {
      rootCalls.push(trace);
    }
  }
  const children = new Map<number, number[]>();
  const roots: number[] = [];
  for (const id of involved) {
    const context = contexts.get(id);
    const parent = context?.parentInvocationId;
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

  const now = Date.now();
  const renderTrace = (trace: CapabilityTrace, depth: number) => {
    const duration = trace.durationMs ?? Math.max(0, now - trace.startedAt);
    const marker =
      trace.status === "running"
        ? theme.fg("accent", "●")
        : trace.status === "succeeded"
          ? theme.fg("success", "✓")
          : theme.fg("error", "✗");
    text += `\n${"  ".repeat(Math.min(depth, 8))}${marker} ${theme.fg("toolTitle", `${trace.capability}.${trace.method}`)} ${theme.fg("dim", `${trace.status}, ${(duration / 1000).toFixed(1)}s`)}`;
  };
  const renderedInvocations = new Set<number>();
  const renderInvocation = (id: number, depth: number) => {
    if (renderedInvocations.has(id)) {
      return;
    }
    renderedInvocations.add(id);
    const context = contexts.get(id);
    if (!context) {
      return;
    }
    text += `\n${"  ".repeat(Math.min(depth, 8))}${theme.fg("accent", "↳")} ${theme.fg("toolTitle", `${context.scope} function`)} ${context.name} ${theme.fg("dim", `#${id}`)}`;
    const events = [
      ...(callsByInvocation.get(id) ?? []).map((trace) => ({
        sequence: trace.sequence,
        trace,
      })),
      ...(children.get(id) ?? []).map((childId) => ({
        sequence: sequenceFor(childId),
        childId,
      })),
    ].sort((left, right) => left.sequence - right.sequence);
    for (const event of events) {
      if ("trace" in event) {
        renderTrace(event.trace, depth + 1);
      } else {
        renderInvocation(event.childId, depth + 1);
      }
    }
  };
  const rootEvents = [
    ...rootCalls.map((trace) => ({ sequence: trace.sequence, trace })),
    ...roots.map((id) => ({ sequence: sequenceFor(id), invocationId: id })),
  ].sort((left, right) => left.sequence - right.sequence);
  for (const event of rootEvents) {
    if ("trace" in event) {
      renderTrace(event.trace, 0);
    } else {
      renderInvocation(event.invocationId, 0);
    }
  }
  if (details?.tracesTruncated) {
    text += `\n${theme.fg("warning", "… additional capability traces omitted")}`;
  }
  return text;
}
