import { retainShellOutputTail } from "../execution/progress.js";
import type { ExecutionProgressSnapshot, ShellProgress } from "../execution/types.js";
import type { FunctionActivity } from "../functions/core.js";
import { parseProcessResult, sanitizeProcessText } from "../process/results.js";
import { sanitizeTerminalText } from "../shared/text-sanitization.js";
import { renderExecutionDashboard } from "./execution-dashboard.js";
import { HangingIndentText } from "./hanging-indent-text.js";

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

interface ReturnedOutput {
  tail: string;
  code?: number;
}

/** Applies the live retention rule to styled text, then drops styling for comparison. */
function unstyledTail(text: string): string {
  return sanitizeTerminalText(retainShellOutputTail(text));
}

/** Returned texts that could be a shell call's whole output, reduced by the live retention rule. */
function returnedOutputs(value: unknown): ReturnedOutput[] {
  const pending = [value];
  const seen = new WeakSet<object>();
  const outputs: ReturnedOutput[] = [];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (typeof entry === "string") {
      if (entry) outputs.push({ tail: unstyledTail(sanitizeProcessText(entry)) });
      continue;
    }
    if (!entry || typeof entry !== "object" || seen.has(entry)) continue;
    seen.add(entry);
    const result = parseProcessResult(entry);
    if (result) {
      // Captured chunks interleave streams; stdout-then-stderr matches only when they did not.
      outputs.push({ tail: unstyledTail(result.stdout + result.stderr), code: result.code });
    } else {
      pending.push(...Object.values(entry));
    }
  }
  return outputs;
}

/** A completed call is shown above only when a returned text yields exactly its retained tail. */
function returnedWhole(entry: ShellProgress, outputs: ReturnedOutput[]): boolean {
  if (entry.status !== "done") return false;
  const retained = sanitizeTerminalText(entry.output);
  return outputs.some(
    ({ tail, code }) => (code === undefined || code === entry.code) && tail === retained,
  );
}

export function renderRetainedShellOutput(
  details: ProgressDetails | undefined,
  theme: RenderTheme,
  returnedValue?: unknown,
): string {
  let text = "";
  let outputs: ReturnedOutput[] | undefined;
  for (const entry of details?.progress ?? []) {
    const status =
      entry.status === "done"
        ? `exit ${entry.code ?? "unknown"}`
        : "unfinished when invocation ended";
    text += `\n${theme.fg("toolTitle", `[${status}] ${entry.command}`)}`;
    if (entry.output) {
      outputs ??= returnedOutputs(returnedValue);
      text += returnedWhole(entry, outputs)
        ? `\n${theme.fg("dim", "(output shown above)")}`
        : `\n${entry.output}`;
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
      const output = shellProgressOutput(group);
      if (output) {
        text += `\n${input.theme.fg("muted", output)}`;
      }
    }
  }
  return new HangingIndentText(sanitizeTerminalText(text, { preserveSgr: true }));
}
