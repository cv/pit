import {
  buildExecutionDashboardModel,
  type DashboardCall,
  type DashboardEvent,
} from "../execution/dashboard-model.js";
import type { HostCallTraceStatus } from "../execution/host-call-trace.js";
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
/** Running call groups a collapsed running invocation lists. */
const COLLAPSED_RUNNING_CALL_GROUPS = 2;

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

function statusLabel(status: HostCallTraceStatus, settled: boolean): string {
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
    let text = `\n${indent}${callMarker(event, theme, settled)} ${theme.fg("toolTitle", `${event.namespace}.${event.method}`)} ${theme.fg("dim", callSummary(event, settled))}`;
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

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * What a collapsed running invocation is doing: its latest running call groups, how many other
 * calls are running, and how many calls have failed so far. Empty while no call is running and
 * none has failed, for example while the program itself computes.
 */
export function renderActiveCallSummary(
  details: ExecutionDashboardDetails | undefined,
  theme: ExecutionDashboardTheme,
): string {
  const calls = callsInOrder(buildExecutionDashboardModel(details).events);
  const count = (call: DashboardCall, statuses: HostCallTraceStatus[]) =>
    call.statuses.reduce(
      (sum, entry) => sum + (statuses.includes(entry.status) ? entry.count : 0),
      0,
    );
  const running = calls.filter((call) => call.status === "running");
  const shown = running.slice(-COLLAPSED_RUNNING_CALL_GROUPS);
  const hiddenRunning = running
    .slice(0, running.length - shown.length)
    .reduce((sum, call) => sum + count(call, ["running"]), 0);
  const failed = calls.reduce((sum, call) => sum + count(call, ["failed", "rejected"]), 0);
  let text = "";
  if (hiddenRunning > 0) {
    text += `\n${theme.fg("dim", `… ${plural(hiddenRunning, "more call")} running`)}`;
  }
  for (const call of shown) {
    text += `\n${callMarker(call, theme, false)} ${theme.fg("toolTitle", `${call.namespace}.${call.method}`)} ${theme.fg("dim", callSummary(call, false))}`;
  }
  if (failed > 0) {
    text += `\n${outcomeMarker(theme, "error")} ${theme.fg("error", `${plural(failed, "call")} failed so far`)}`;
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
    text += `\n${theme.fg("warning", "… additional host-call traces omitted")}`;
  }
  return text;
}
