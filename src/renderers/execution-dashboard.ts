import type { CapabilityTraceStatus } from "../execution/capability-trace.js";
import {
  buildExecutionDashboardModel,
  type DashboardCall,
  type DashboardEvent,
} from "../execution/dashboard-model.js";
import type { ExecutionProgressSnapshot } from "../execution/types.js";
import type { FunctionActivity } from "../functions/core.js";

interface ExecutionDashboardDetails extends ExecutionProgressSnapshot {
  functions?: FunctionActivity[];
}

interface ExecutionDashboardTheme {
  fg(color: string, text: string): string;
}

function callMarker(call: DashboardCall, theme: ExecutionDashboardTheme, settled: boolean): string {
  if (call.status === "running") {
    return settled ? theme.fg("warning", "?") : theme.fg("accent", "●");
  }
  if (call.status === "succeeded") {
    return theme.fg("dim", "·");
  }
  return theme.fg("error", "✗");
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
  const seconds = `${(call.durationMs / 1000).toFixed(1)}s`;
  return call.count === 1 ? `${outcome}, ${seconds}` : `${outcome} over ${seconds}`;
}

function renderEvent(
  event: DashboardEvent,
  depth: number,
  theme: ExecutionDashboardTheme,
  settled: boolean,
): string {
  const indent = "  ".repeat(Math.min(depth, 8));
  if (event.kind === "call") {
    return `\n${indent}${callMarker(event, theme, settled)} ${theme.fg("toolTitle", `${event.capability}.${event.method}`)} ${theme.fg("dim", callSummary(event, settled))}`;
  }
  let text = `\n${indent}${theme.fg("accent", "↳")} ${theme.fg("toolTitle", `${event.scope} function`)} ${event.name} ${theme.fg("dim", `#${event.id}`)}`;
  for (const child of event.events) {
    text += renderEvent(child, depth + 1, theme, settled);
  }
  return text;
}

export function renderExecutionDashboard(
  details: ExecutionDashboardDetails | undefined,
  theme: ExecutionDashboardTheme,
  settled = false,
): string {
  const model = buildExecutionDashboardModel(details);
  let text = "";
  for (const activity of model.activities) {
    text += `\n${theme.fg("accent", "↳")} ${theme.fg("toolTitle", `${activity.scope} function`)} ${activity.name}`;
  }
  for (const event of model.events) {
    text += renderEvent(event, 0, theme, settled);
  }
  if (model.tracesTruncated) {
    text += `\n${theme.fg("warning", "… additional capability traces omitted")}`;
  }
  return text;
}
