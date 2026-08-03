import { highlightCode } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  type CapabilityCall,
  describeCapabilityCall,
  inferCapabilityCall,
} from "./capability-presentation.js";
import type { ExecutionProgressSnapshot, ShellProgress } from "./execution-types.js";
import { HangingIndentText } from "./hanging-indent-text.js";
import { renderExecutionDashboard } from "./renderers/execution-dashboard.js";
import { renderResultValue } from "./renderers/generic.js";
import type { RenderedResultValue } from "./result-renderer-types.js";
import { getNamedFunctionName, resolveSavedFunctionReferences } from "./sandbox.js";
import type { FunctionActivity, FunctionRegistry } from "./saved-functions.js";
import { sanitizeTerminalText } from "./text-sanitization.js";
import type { StructuredTypeScriptFailure } from "./typescript-failure-context.js";
import { displayedFailure, displayedFunctionPath } from "./typescript-failure-presentation.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 200;

interface TypeScriptDetails extends ExecutionProgressSnapshot {
  value: unknown;
  truncated: boolean;
  functions?: FunctionActivity[];
  failure?: StructuredTypeScriptFailure;
}

function runtimeCapabilityCall(details: TypeScriptDetails): CapabilityCall | undefined {
  if (!details.traces) {
    return;
  }
  const publicTraces = details.traces.filter((entry) => entry.capability !== "__pit");
  if (publicTraces.length !== 1) {
    return;
  }
  const trace = publicTraces[0] as (typeof publicTraces)[number];
  return {
    capability: trace.capability,
    method: trace.method,
    qualifiedName: `${trace.capability}.${trace.method}`,
  };
}

interface ActiveTimingState {
  startedAt?: number;
  completedAt?: number;
  timer?: ReturnType<typeof setInterval> | undefined;
}

interface TypeScriptRendererState {
  generation?: ActiveTimingState;
  execution?: ActiveTimingState;
}

interface RenderTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

interface ToolCallArgs {
  label?: unknown;
  code?: unknown;
  saveOnly?: unknown;
}

interface ToolCallContext {
  expanded: boolean;
  argsComplete: boolean;
  executionStarted?: boolean;
  isPartial?: boolean;
  state?: unknown;
  invalidate?: () => void;
}

interface ToolResultLike {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
}

interface ToolResultContext {
  args?: { code?: unknown };
  isError?: boolean;
  state?: unknown;
  invalidate?: () => void;
}

function spinnerFrame(elapsedMs: number): string {
  const index = Math.floor(Math.max(0, elapsedMs) / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[index] as (typeof SPINNER_FRAMES)[number];
}

function normalizedLabel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return;
  }
  const label = sanitizeTerminalText(value).replace(/\s+/g, " ").trim();
  return label || undefined;
}

function rendererState(value: unknown): TypeScriptRendererState {
  return value && typeof value === "object" ? (value as TypeScriptRendererState) : {};
}

function timingState(
  state: TypeScriptRendererState,
  phase: keyof TypeScriptRendererState,
): ActiveTimingState {
  const timing = state[phase] ?? {};
  state[phase] = timing;
  return timing;
}

function activeTiming(
  state: ActiveTimingState,
  complete: boolean,
  invalidate?: () => void,
): { duration: string; spinner: string } {
  const now = Date.now();
  state.startedAt ??= now;
  if (complete) {
    state.completedAt ??= now;
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = undefined;
    }
  } else if (!state.timer && invalidate) {
    state.timer = setInterval(invalidate, SPINNER_INTERVAL_MS);
    (state.timer as { unref?: () => void }).unref?.();
  }
  const elapsed = (state.completedAt ?? now) - state.startedAt;
  return {
    duration: `${(Math.max(0, elapsed) / 1000).toFixed(1)}s`,
    spinner: spinnerFrame(elapsed),
  };
}

function generationTiming(context: ToolCallContext): {
  duration: string;
  complete: boolean;
  spinner: string;
} {
  const state = rendererState(context.state);
  const complete =
    context.argsComplete || context.executionStarted === true || context.isPartial === false;
  if (context.executionStarted === true) {
    timingState(state, "execution").startedAt ??= Date.now();
  }
  return {
    ...activeTiming(timingState(state, "generation"), complete, context.invalidate),
    complete,
  };
}

function executionTiming(
  context: ToolResultContext,
  complete: boolean,
): { duration: string; spinner: string } {
  const state = rendererState(context.state);
  return activeTiming(timingState(state, "execution"), complete, context.invalidate);
}

function describeCall(
  label: unknown,
  code: string,
  saveOnly: boolean,
  registry: FunctionRegistry,
): string {
  const supplied = normalizedLabel(label);
  if (supplied) {
    return supplied;
  }
  const named = getNamedFunctionName(code);
  if (named) {
    return `${saveOnly ? "Save" : "Define and run"} ${named}`;
  }
  const direct = resolveSavedFunctionReferences(code, registry).find(
    (reference) => reference.direct,
  );
  if (direct) {
    return `Run ${direct.name}`;
  }
  return describeCapabilityCall(inferCapabilityCall(code)) ?? "Run workspace task";
}

function describeResult(
  value: unknown,
  structured: RenderedResultValue | undefined,
  truncated: boolean,
  fallback: string,
): string {
  if (truncated) {
    return "Truncated output";
  }
  if (structured) {
    const summary = structured.summary ? ` ${structured.summary}` : "";
    const verbs: Record<string, string> = {
      read: "Read",
      search: "Found",
      edit: "Edit",
      shell: "Command",
      git: "Git",
      npm: "npm",
      gh: "GitHub",
      list: "Listed",
      glob: "Listed",
      http: "Received",
      batch: "Batch",
      stat: "Stat",
      compound: "Returned",
    };
    return `${verbs[structured.kind] ?? "Returned"}${summary}`;
  }
  if (value === undefined) {
    return fallback ? "Returned text" : "No returned value";
  }
  if (Array.isArray(value)) {
    return `Returned ${value.length} item${value.length === 1 ? "" : "s"}`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    const names = keys.slice(0, 3).join(", ");
    return `Returned ${keys.length} field${keys.length === 1 ? "" : "s"}${names ? `: ${names}` : ""}`;
  }
  return `Returned ${typeof value}`;
}

export function renderTypeScriptToolCall(
  args: ToolCallArgs,
  theme: RenderTheme,
  context: ToolCallContext,
  registry: FunctionRegistry,
) {
  const code = typeof args.code === "string" ? args.code : "";
  const callLabel = describeCall(args.label, code, args.saveOnly === true, registry);
  const lines = code ? highlightCode(code, "typescript") : [];
  const shown = context.expanded ? lines : [];
  const generation = generationTiming(context);
  const state = generation.complete
    ? `${lines.length} line${lines.length === 1 ? "" : "s"}, ${generation.duration}`
    : `generating... ${generation.duration}`;
  const callMarker = generation.complete ? "› " : `${generation.spinner} `;
  let text = theme.bold(
    theme.fg("accent", callMarker) +
      theme.fg("toolTitle", callLabel) +
      theme.fg("dim", ` (${state})`),
  );
  if (args.saveOnly === true) {
    text += theme.fg("accent", " save-only");
  }
  if (context.expanded && shown.length > 0) {
    text += `\n${shown.join("\n")}`;
  } else if (context.expanded) {
    text += `\n${theme.fg("dim", context.argsComplete ? "(empty source)" : "(waiting for source…)")}`;
  }

  return new Text(text, 0, 0);
}

interface ResultRenderingState {
  lines: string[];
  hangingIndents: Record<number, number>;
  structuredResult?: RenderedResultValue;
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

function renderPartialToolResult(input: {
  expanded: boolean;
  details?: TypeScriptDetails;
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
    for (const group of progressGroups.slice(-4)) {
      text += `\n${input.theme.fg("accent", `[${shellProgressState(group)}]`)} ${input.theme.fg("dim", group.command)}`;
      const output = shellProgressOutput(group);
      if (output) {
        text += `\n${input.theme.fg("muted", output)}`;
      }
    }
    if (input.details?.progressTruncated || progressGroups.length > 4) {
      text += `\n${input.theme.fg("warning", "… earlier shell calls omitted")}`;
    }
  }
  return new Text(text, 0, 0);
}

function renderToolError(input: {
  expanded: boolean;
  details?: TypeScriptDetails;
  fallback: string;
  duration: string;
  theme: RenderTheme;
}) {
  const rawMessage =
    input.details?.failure?.rootError || input.fallback || "TypeScript execution failed";
  const message = displayedFailure(rawMessage, input.expanded);
  let text = `${input.expanded ? "\n" : ""}${input.theme.bold(
    input.theme.fg("error", "✗ Failed") + input.theme.fg("dim", ` (${input.duration})`),
  )}`;
  if (input.expanded) {
    const path = input.details?.failure ? input.details.failure.functionPath : [];
    if (path.length > 0) {
      text += `\n${input.theme.fg("toolTitle", "Function path")}\n${input.theme.fg("muted", displayedFunctionPath(path))}`;
    }
    const dashboard = renderExecutionDashboard(input.details, input.theme);
    if (dashboard) {
      text += `\n${input.theme.fg("toolTitle", "Execution")}${dashboard}`;
    }
  }
  text += `\n${input.theme.fg("error", message)}`;
  return new Text(text, 0, 0);
}

function renderStructuredToolValue(input: {
  details?: TypeScriptDetails;
  fallback: string;
  theme: RenderTheme;
  context: ToolResultContext;
}): ResultRenderingState {
  const { details, fallback, theme, context } = input;
  if (!(details && !details.truncated)) {
    return {
      lines: fallback ? highlightCode(fallback, "typescript") : [],
      hangingIndents: {},
    };
  }
  if (details.value === undefined) {
    return { lines: highlightCode("undefined", "typescript"), hangingIndents: {} };
  }
  const source = typeof context.args?.code === "string" ? context.args.code : "";
  const capabilityCall = runtimeCapabilityCall(details) ?? inferCapabilityCall(source);
  const structuredResult = renderResultValue(details.value, theme, capabilityCall);
  if (structuredResult) {
    return {
      lines: structuredResult.lines,
      hangingIndents: structuredResult.hangingIndents ?? {},
      structuredResult,
    };
  }
  let serialized: string;
  let language = "json";
  try {
    serialized = JSON.stringify(details.value, null, 2) ?? String(details.value);
  } catch {
    serialized = String(details.value);
    language = "typescript";
  }
  return { lines: highlightCode(serialized, language), hangingIndents: {} };
}

function renderCompletedToolResult(input: {
  expanded: boolean;
  details?: TypeScriptDetails;
  fallback: string;
  duration: string;
  theme: RenderTheme;
  rendering: ResultRenderingState;
}) {
  const { expanded, details, fallback, duration, theme, rendering } = input;
  const shown = expanded ? rendering.lines : [];
  const state = details?.truncated
    ? `truncated, ${duration}`
    : `${rendering.lines.length} line${rendering.lines.length === 1 ? "" : "s"}, ${duration}`;
  const resultLabel = describeResult(
    details?.value,
    rendering.structuredResult,
    details?.truncated === true,
    fallback,
  );
  const resultOutcome = details?.truncated
    ? "warning"
    : (rendering.structuredResult?.outcome ?? "success");
  const resultMarker =
    resultOutcome === "warning"
      ? theme.fg("warning", "⚠ ")
      : resultOutcome === "error"
        ? theme.fg("error", "✗ ")
        : theme.fg("success", "✓ ");
  let text = `${expanded ? "\n" : ""}${theme.bold(
    resultMarker +
      theme.fg("toolTitle", resultLabel) +
      theme.fg(resultOutcome === "success" ? "dim" : resultOutcome, ` (${state})`),
  )}`;
  if (expanded) {
    const dashboard = renderExecutionDashboard(details, theme);
    if (dashboard) {
      text += `\n${theme.bold(theme.fg("toolTitle", "Execution"))}${dashboard}`;
    }
  }
  const resultContentStart = text.split("\n").length;
  if (expanded && shown.length > 0) {
    text += `\n${shown.join("\n")}`;
  } else if (expanded) {
    text += `\n${theme.fg("dim", "(no result)")}`;
  }
  const displayedHangingIndents = Object.fromEntries(
    Object.entries(rendering.hangingIndents)
      .filter(([index]) => Number(index) < shown.length)
      .map(([index, width]) => [resultContentStart + Number(index), width]),
  );
  return Object.keys(displayedHangingIndents).length > 0
    ? new HangingIndentText(text, displayedHangingIndents)
    : new Text(text, 0, 0);
}

export function renderTypeScriptToolResult(
  result: ToolResultLike,
  options: { expanded: boolean; isPartial: boolean },
  theme: RenderTheme,
  context: ToolResultContext,
) {
  const content = result.content[0];
  const fallback = content?.type === "text" ? (content.text ?? "") : "";
  const details = result.details as TypeScriptDetails | undefined;
  const execution = executionTiming(context, !options.isPartial || context.isError === true);
  if (options.isPartial) {
    return renderPartialToolResult({
      expanded: options.expanded,
      ...(details ? { details } : {}),
      theme,
      execution,
    });
  }
  if (context.isError) {
    return renderToolError({
      expanded: options.expanded,
      ...(details ? { details } : {}),
      fallback,
      duration: execution.duration,
      theme,
    });
  }
  const rendering = renderStructuredToolValue({
    ...(details ? { details } : {}),
    fallback,
    theme,
    context,
  });
  return renderCompletedToolResult({
    expanded: options.expanded,
    ...(details ? { details } : {}),
    fallback,
    duration: execution.duration,
    theme,
    rendering,
  });
}
