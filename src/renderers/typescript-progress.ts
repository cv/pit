import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";

import type { ExecutionProgressSnapshot, ShellProgress } from "../execution/types.js";
import type { FunctionActivity } from "../functions/core.js";
import { parseProcessResult } from "../process/results.js";
import { sanitizeTerminalText } from "../shared/text-sanitization.js";
import { renderExecutionDashboard } from "./execution-dashboard.js";

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

function shellProgressOutput(group: ShellProgressGroup): string {
  const latest = group.entries[group.entries.length - 1] as ShellProgress;
  if (group.entries.length === 1 || latest.status === "running") {
    return latest.output;
  }
  return "";
}

function returnedProcessOutputs(value: unknown): string[] {
  const pending = [value];
  const seen = new WeakSet<object>();
  const outputs: string[] = [];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (!entry || typeof entry !== "object" || seen.has(entry)) continue;
    seen.add(entry);
    const result = parseProcessResult(entry);
    if (result) {
      // Match the displayed stdout-then-stderr ordering, not an unordered set of lines.
      outputs.push(sanitizeTerminalText(result.stdout + result.stderr));
    } else {
      pending.push(...Object.values(entry));
    }
  }
  return outputs;
}

export function renderRetainedShellOutput(
  details: ProgressDetails | undefined,
  theme: RenderTheme,
  returnedLines: string[] = [],
  returnedValue?: unknown,
): string {
  let text = "";
  const displayed = stripTerminalSequences(returnedLines.join("\n"));
  const processOutputs = returnedProcessOutputs(returnedValue);
  for (const entry of details?.progress ?? []) {
    const status =
      entry.status === "done"
        ? `exit ${entry.code ?? "unknown"}`
        : "unfinished when invocation ended";
    text += `\n${theme.fg("toolTitle", `[${status}] ${entry.command}`)}`;
    if (entry.output) {
      const output = sanitizeTerminalText(entry.output);
      const alreadyShown =
        displayed.includes(output) || processOutputs.some((value) => value.includes(output));
      text += alreadyShown ? `\n${theme.fg("dim", "(output shown above)")}` : `\n${entry.output}`;
    }
  }
  if (details?.progressTruncated)
    text += `\n${theme.fg("warning", "… earlier shell calls were not retained")}`;
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
    const progressGroups = groupAdjacentShellProgress(input.details?.progress ?? []);
    const visible = progressGroups.filter(
      (group, index) =>
        index >= progressGroups.length - 4 ||
        group.entries.some((entry) => failedShellProgress(entry) || entry.status === "running"),
    );
    for (const group of visible) {
      text += `\n${input.theme.fg("accent", `[${shellProgressState(group)}]`)} ${input.theme.fg("dim", group.command)}`;
      const output = shellProgressOutput(group);
      if (output) {
        text += `\n${input.theme.fg("muted", output)}`;
      }
    }
    if (input.details?.progressTruncated || visible.length < progressGroups.length) {
      text += `\n${input.theme.fg("warning", "… earlier shell calls omitted")}`;
    }
  }
  return new Text(sanitizeTerminalText(text, { preserveSgr: true }), 0, 0);
}
