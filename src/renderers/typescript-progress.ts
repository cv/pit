import type { ExecutionProgressSnapshot, ShellProgress } from "../execution/types.js";
import type { FunctionActivity } from "../functions/core.js";
import { sanitizeTerminalText } from "../shared/text-sanitization.js";
import { renderExecutionDashboard } from "./execution-dashboard.js";
import { HangingIndentText } from "./hanging-indent-text.js";
import {
  linkedProcessProgress,
  processProgressRenderer,
  retainedOutputLines,
} from "./process-progress.js";

interface ProgressDetails extends ExecutionProgressSnapshot {
  functions?: FunctionActivity[];
}

interface RenderTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

interface ShellProgressGroup {
  command: string;
  entries: [ShellProgress, ...ShellProgress[]];
}

function failedShellProgress(progress: ShellProgress): boolean {
  return progress.status === "done" && progress.code !== 0;
}

function groupAdjacentShellProgress(progress: ShellProgress[]): ShellProgressGroup[] {
  const groups: ShellProgressGroup[] = [];
  for (const entry of progress) {
    const previous = groups.at(-1);
    const previousEntry = previous?.entries.at(-1);
    if (
      previous &&
      previousEntry &&
      previous.command === entry.command &&
      !failedShellProgress(previousEntry) &&
      !failedShellProgress(entry)
    ) {
      previous.entries.push(entry);
    } else {
      groups.push({ command: entry.command, entries: [entry] });
    }
  }
  return groups;
}

function shellProgressState(group: ShellProgressGroup): string {
  if (group.entries.length === 1) {
    const entry = group.entries[0];
    return entry.status === "done" ? `done (${entry.code})` : "running";
  }
  const running = group.entries.filter((entry) => entry.status === "running").length;
  const completedByCode = new Map<number | undefined, number>();
  for (const entry of group.entries) {
    if (entry.status === "done") {
      completedByCode.set(entry.code, (completedByCode.get(entry.code) ?? 0) + 1);
    }
  }
  const states = [
    ...(running > 0 ? [`${running === 1 ? "" : `${running} `}running`] : []),
    ...[...completedByCode].map(([code, count]) => `${count} done (${code})`),
  ];
  return states.join(", ");
}

function shellProgressOutput(group: ShellProgressGroup, theme: RenderTheme): string {
  const latest = group.entries[group.entries.length - 1] as ShellProgress;
  if (group.entries.length === 1 || latest.status === "running") {
    return retainedOutputLines(latest, theme, (line) => theme.fg("muted", line)).join("\n");
  }
  return "";
}

export function renderRetainedShellOutput(
  details: ProgressDetails | undefined,
  theme: RenderTheme,
  returnedValue?: unknown,
): string {
  const render = processProgressRenderer(theme, returnedValue);
  let text = linkedProcessProgress(details)
    .unlinked.map((entry) => render(entry, { settled: true }))
    .join("");
  if (details?.progressTruncated)
    text += `
${theme.fg("warning", "… earlier shell calls were not retained")}`;
  return text;
}

export function renderPartialToolResult(input: {
  expanded: boolean;
  details?: ProgressDetails;
  theme: RenderTheme;
  execution: { spinner: string; duration: string };
}) {
  let text = input.theme.bold(
    input.theme.fg("accent", `${input.execution.spinner} `) +
      input.theme.fg("toolTitle", "Running...") +
      input.theme.fg("dim", ` (${input.execution.duration})`),
  );
  if (input.expanded) {
    text += renderExecutionDashboard(input.details, input.theme);
    const progressGroups = groupAdjacentShellProgress(
      linkedProcessProgress(input.details).unlinked,
    );
    const visible = new Set(
      progressGroups.filter(
        (group, index) =>
          index >= progressGroups.length - 4 ||
          group.entries.some((entry) => failedShellProgress(entry) || entry.status === "running"),
      ),
    );
    const hidden = progressGroups.reduce(
      (count, group) => count + (visible.has(group) ? 0 : group.entries.length),
      0,
    );
    if (input.details?.progressTruncated) {
      text += `\n${input.theme.fg("warning", "… earlier shell calls were not retained")}`;
    }
    if (hidden > 0) {
      text += `\n${input.theme.fg("dim", `… ${hidden} earlier shell call${hidden === 1 ? "" : "s"} hidden while running; listed when finished`)}`;
    }
    for (const group of visible) {
      text += `\n${input.theme.fg("accent", `[${shellProgressState(group)}]`)} ${input.theme.fg("dim", group.command)}`;
      const output = shellProgressOutput(group, input.theme);
      if (output) {
        text += `\n${output}`;
      }
    }
  }
  return new HangingIndentText(sanitizeTerminalText(text, { preserveSgr: true }));
}
