import { highlightCode } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type CapabilityCall, inferCapabilityCall } from "./capability-presentation.js";
import type { ExecutionProgressSnapshot } from "./execution-types.js";
import { HangingIndentText } from "./hanging-indent-text.js";
import { renderExecutionDashboard } from "./renderers/execution-dashboard.js";
import { renderResultValue } from "./renderers/generic.js";
import type { RenderedResultValue } from "./result-renderer-types.js";
import type { FunctionActivity } from "./saved-functions.js";
import type { StructuredTypeScriptFailure } from "./typescript-failure-context.js";
import { displayedFailure, displayedFunctionPath } from "./typescript-failure-presentation.js";
import { renderPartialToolResult } from "./typescript-progress-renderer.js";
import { executionTiming } from "./typescript-tool-timing.js";

const _SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const _SPINNER_INTERVAL_MS = 200;

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

interface RenderTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
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

interface ResultRenderingState {
  lines: string[];
  hangingIndents: Record<number, number>;
  structuredResult?: RenderedResultValue;
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
