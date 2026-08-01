import { highlightCode } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  type CapabilityCall,
  describeCapabilityCall,
  inferCapabilityCall,
} from "./capability-presentation.js";
import type { ExecutionProgressSnapshot } from "./execution-types.js";
import { HangingIndentText } from "./hanging-indent-text.js";
import type { RenderedResultValue } from "./result-renderer-types.js";
import { renderResultValue } from "./result-renderers.js";
import { getNamedFunctionName, resolveSavedFunctionReferences } from "./sandbox.js";
import type { FunctionActivity, FunctionRegistry } from "./saved-functions.js";
import { sanitizeTerminalText } from "./text-sanitization.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 80;

interface TypeScriptDetails extends ExecutionProgressSnapshot {
  value: unknown;
  truncated: boolean;
  functions?: FunctionActivity[];
}

function runtimeCapabilityCall(details: TypeScriptDetails): CapabilityCall | undefined {
  if (!details.traces) {
    return;
  }
  const publicTraces = details.traces.filter((entry) => entry.capability !== "__pit");
  if (publicTraces.length !== 1) {
    return;
  }
  const [trace] = publicTraces;
  if (!trace) {
    return;
  }
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

function renderExecutionDashboard(
  details: TypeScriptDetails | undefined,
  theme: RenderTheme,
): string {
  let text = "";
  const activities = details?.functions;
  for (const activity of activities
    ? activities.filter((entry) => entry.action === "run").slice(-4)
    : []) {
    const scope = activity.scope ?? "session";
    text += `\n${theme.fg("accent", "↳")} ${theme.fg("toolTitle", `${scope} function`)} ${activity.name}`;
  }
  const now = Date.now();
  const traceEntries = details?.traces;
  const traces = traceEntries
    ? traceEntries.filter((trace) => trace.capability !== "__pit").slice(-8)
    : [];
  for (const trace of traces) {
    const duration = trace.durationMs ?? Math.max(0, now - trace.startedAt);
    const marker =
      trace.status === "running"
        ? theme.fg("accent", "●")
        : trace.status === "succeeded"
          ? theme.fg("success", "✓")
          : theme.fg("error", "✗");
    text += `\n${marker} ${theme.fg("toolTitle", `${trace.capability}.${trace.method}`)} ${theme.fg("dim", `${trace.status}, ${(duration / 1000).toFixed(1)}s`)}`;
  }
  if (details?.tracesTruncated) {
    text += `\n${theme.fg("warning", "… additional capability traces omitted")}`;
  }
  return text;
}

export function renderTypeScriptToolResult(
  result: ToolResultLike,
  options: { expanded: boolean; isPartial: boolean },
  theme: RenderTheme,
  context: ToolResultContext,
) {
  const { expanded, isPartial } = options;
  const content = result.content[0];
  const fallback = content?.type === "text" ? (content.text ?? "") : "";
  const details = result.details as TypeScriptDetails | undefined;
  const execution = executionTiming(context, !isPartial || context.isError === true);
  if (isPartial) {
    let text = theme.bold(
      theme.fg("accent", `${execution.spinner} `) +
        theme.fg("toolTitle", "Running...") +
        theme.fg("dim", ` (${execution.duration})`),
    );
    if (expanded) {
      text += renderExecutionDashboard(details, theme);
      for (const progress of details?.progress?.slice(-4) ?? []) {
        const state = progress.status === "done" ? `done (${progress.code})` : "running";
        text += `\n${theme.fg("accent", `[${state}]`)} ${theme.fg("dim", progress.command)}`;
        if (progress.output) {
          text += `\n${theme.fg("muted", progress.output)}`;
        }
      }
    }
    return new Text(text, 0, 0);
  }
  if (context.isError) {
    const message = fallback || "TypeScript execution failed";
    return new Text(
      `${expanded ? "\n" : ""}${theme.bold(
        theme.fg("error", "✗ Failed") + theme.fg("dim", ` (${execution.duration})`),
      )}\n${theme.fg("error", message)}`,
      0,
      0,
    );
  }

  let lines: string[];
  let hangingIndents: Record<number, number> = {};
  let structuredResult: RenderedResultValue | undefined;
  if (details && !details.truncated) {
    if (details.value === undefined) {
      lines = highlightCode("undefined", "typescript");
    } else {
      const source = typeof context.args?.code === "string" ? context.args.code : "";
      const capabilityCall = runtimeCapabilityCall(details) ?? inferCapabilityCall(source);
      structuredResult = renderResultValue(details.value, theme, capabilityCall);
      if (structuredResult) {
        lines = structuredResult.lines;
        hangingIndents = structuredResult.hangingIndents ?? {};
      } else {
        let serialized: string;
        let language = "json";
        try {
          serialized = JSON.stringify(details.value, null, 2) ?? String(details.value);
        } catch {
          serialized = String(details.value);
          language = "typescript";
        }
        lines = highlightCode(serialized, language);
      }
    }
  } else {
    lines = fallback ? highlightCode(fallback, "typescript") : [];
  }
  const shown = expanded ? lines : [];
  const state = details?.truncated
    ? `truncated, ${execution.duration}`
    : `${lines.length} line${lines.length === 1 ? "" : "s"}, ${execution.duration}`;
  const resultLabel = describeResult(
    details?.value,
    structuredResult,
    details?.truncated === true,
    fallback,
  );
  const resultMarker = details?.truncated ? theme.fg("warning", "… ") : theme.fg("success", "✓ ");
  let text = `${expanded ? "\n" : ""}${theme.bold(
    resultMarker +
      theme.fg("toolTitle", resultLabel) +
      theme.fg(details?.truncated ? "warning" : "dim", ` (${state})`),
  )}`;
  const resultContentStart = text.split("\n").length;
  if (expanded && shown.length > 0) {
    text += `\n${shown.join("\n")}`;
  } else if (expanded) {
    text += `\n${theme.fg("dim", "(no result)")}`;
  }
  const displayedHangingIndents = Object.fromEntries(
    Object.entries(hangingIndents)
      .filter(([index]) => Number(index) < shown.length)
      .map(([index, width]) => [resultContentStart + Number(index), width]),
  );
  return Object.keys(displayedHangingIndents).length > 0
    ? new HangingIndentText(text, displayedHangingIndents)
    : new Text(text, 0, 0);
}
