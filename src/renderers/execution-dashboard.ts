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

function renderEvent(
  event: DashboardEvent,
  depth: number,
  theme: ExecutionDashboardTheme,
  settled: boolean,
): string {
  const indent = "  ".repeat(Math.min(depth, 8));
  if (event.kind === "call") {
    const summary =
      settled && event.status === "running"
        ? event.summary
            .replace(/, [\d.]+s$| over [\d.]+s$/, "")
            .replaceAll("running", "unfinished at end")
        : event.summary;
    return `\n${indent}${callMarker(event, theme, settled)} ${theme.fg("toolTitle", `${event.capability}.${event.method}`)} ${theme.fg("dim", summary.replaceAll("succeeded", "completed"))}`;
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
