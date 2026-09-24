import type { CapabilityTraceStatus } from "../execution/capability-trace.js";
import {
  buildExecutionDashboardModel,
  type DashboardCall,
  type DashboardEvent,
} from "../execution/dashboard-model.js";
import { formatDuration } from "../execution/timings.js";
import type { ExecutionProgressSnapshot } from "../execution/types.js";
import type { FunctionActivity } from "../functions/core.js";
import { linkedProcessProgress, processProgressRenderer } from "./process-progress.js";
import { outcomeMarker } from "./shared.js";

interface ExecutionDashboardDetails extends ExecutionProgressSnapshot {
  functions?: FunctionActivity[];
}

interface ExecutionDashboardTheme {
  fg(color: string, text: string): string;
}

/** Completed call groups older than this many recent rows are hidden while an invocation runs. */
const LIVE_RECENT_CALL_GROUPS = 12;

function callsInOrder(events: DashboardEvent[]): DashboardCall[] {
  return events.flatMap((event) => (event.kind === "call" ? [event] : callsInOrder(event.events)));
}

function keepEvents(events: DashboardEvent[], kept: Set<DashboardCall>): DashboardEvent[] {
  return events.flatMap((event): DashboardEvent[] => {
    if (event.kind === "call") {
      return kept.has(event) ? [event] : [];
    }
    if (event.events.length === 0) {
      return [event];
    }
    const children = keepEvents(event.events, kept);
    return children.length > 0 ? [{ ...event, events: children }] : [];
  });
}

/**
 * A live view keeps running, failed, rejected, and recent call groups so the invocation stays
 * oriented; the settled view lists every retained call.
 */
function liveEvents(
  events: DashboardEvent[],
  processes: EventRendering["processes"],
): { events: DashboardEvent[]; hiddenCalls: number } {
  const calls = callsInOrder(events);
  const firstRecent = calls.length - LIVE_RECENT_CALL_GROUPS;
  const kept = new Set(
    calls.filter(
      (call, index) =>
        index >= firstRecent ||
        call.status !== "succeeded" ||
        call.sequences.some((sequence) =>
          processes.get(sequence)?.some((entry) => entry.status === "running" || entry.code !== 0),
        ),
    ),
  );
  if (kept.size === calls.length) {
    return { events, hiddenCalls: 0 };
  }
  const hiddenCalls = calls.reduce((sum, call) => sum + (kept.has(call) ? 0 : call.count), 0);
  return { events: keepEvents(events, kept), hiddenCalls };
}

function callMarker(call: DashboardCall, theme: ExecutionDashboardTheme, settled: boolean): string {
  if (call.status === "running") {
    return settled ? theme.fg("warning", "?") : theme.fg("accent", "●");
  }
  if (call.status === "succeeded") {
    return theme.fg("dim", "·");
  }
  return outcomeMarker(theme, "error");
}

function statusLabel(status: CapabilityTraceStatus, settled: boolean): string {
  if (status === "running") {
    return settled ? "unfinished at end" : "running";
  }
  return status === "succeeded" ? "completed" : status;
}

function callSummary(call: DashboardCall, settled: boolean): string {
  const [only] = call.statuses;
  const outcome =
    call.statuses.length === 1 && only
      ? `${statusLabel(only.status, settled)}${call.count > 1 ? ` ×${call.count}` : ""}`
      : call.statuses
          .map(({ status, count }) => `${count} ${statusLabel(status, settled)}`)
          .join(", ");
  // A settled view has no finish time for unfinished calls, so their elapsed time is unknown.
  if (settled && call.unfinished) {
    return outcome;
  }
  const duration = formatDuration(call.durationMs);
  return call.count === 1 ? `${outcome}, ${duration}` : `${outcome} over ${duration}`;
}

interface EventRendering {
  theme: ExecutionDashboardTheme;
  settled: boolean;
  processes: ReturnType<typeof linkedProcessProgress>["linked"];
  renderProcess: ReturnType<typeof processProgressRenderer>;
}

function renderEvent(event: DashboardEvent, depth: number, context: EventRendering): string {
  const { theme, settled } = context;
  const indent = "  ".repeat(Math.min(depth, 8));
  if (event.kind === "call") {
    let text = `\n${indent}${callMarker(event, theme, settled)} ${theme.fg("toolTitle", `${event.capability}.${event.method}`)} ${theme.fg("dim", callSummary(event, settled))}`;
    for (const sequence of event.sequences) {
      for (const process of context.processes.get(sequence) ?? []) {
        text += context.renderProcess(process, { settled, indent: indent + "  ", compact: true });
      }
    }
    return text;
  }
  let text = `\n${indent}${theme.fg("accent", "↳")} ${theme.fg("toolTitle", `${event.scope} function`)} ${event.name} ${theme.fg("dim", `#${event.id}`)}`;
  for (const child of event.events) {
    text += renderEvent(child, depth + 1, context);
  }
  return text;
}

export function renderExecutionDashboard(
  details: ExecutionDashboardDetails | undefined,
  theme: ExecutionDashboardTheme,
  settled = false,
  returnedValue?: unknown,
): string {
  const context: EventRendering = {
    theme,
    settled,
    processes: linkedProcessProgress(details).linked,
    renderProcess: processProgressRenderer(theme, returnedValue),
  };
  const model = buildExecutionDashboardModel(details);
  const { events, hiddenCalls } = settled
    ? { events: model.events, hiddenCalls: 0 }
    : liveEvents(model.events, context.processes);
  let text = "";
  for (const activity of model.activities) {
    text += `\n${theme.fg("accent", "↳")} ${theme.fg("toolTitle", `${activity.scope} function`)} ${activity.name}`;
  }
  if (hiddenCalls > 0) {
    text += `\n${theme.fg("dim", `… ${hiddenCalls} earlier completed call${hiddenCalls === 1 ? "" : "s"} hidden while running; listed when finished`)}`;
  }
  for (const event of events) {
    text += renderEvent(event, 0, context);
  }
  if (model.tracesTruncated) {
    text += `\n${theme.fg("warning", "… additional capability traces omitted")}`;
  }
  return text;
}
