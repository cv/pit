import { highlightCode } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { ExecutionProgressSnapshot } from "../execution/types.js";
import type { FunctionActivity } from "../functions/core.js";
import { sanitizeTerminalText } from "../shared/text-sanitization.js";
import type { StructuredTypeScriptFailure } from "../tool/failure-context.js";
import { executionTiming } from "../tool/timing.js";
import { type CapabilityCall, inferCapabilityCall } from "./capability.js";
import { renderExecutionDashboard } from "./execution-dashboard.js";
import { renderResultValue } from "./generic.js";
import { HangingIndentText } from "./hanging-indent-text.js";
import { isRecord, renderJson } from "./shared.js";
import type { RenderedResultValue } from "./types.js";
import { displayedFailure, displayedFunctionPath } from "./typescript-failure.js";
import { renderPartialToolResult, renderRetainedShellOutput } from "./typescript-progress.js";
import { renderTypeScriptInputs, type ToolCallArgs } from "./typescript-tool-call.js";

interface TypeScriptDetails extends ExecutionProgressSnapshot {
  value: unknown;
  truncated: boolean;
  functions?: FunctionActivity[];
  failure?: StructuredTypeScriptFailure;
}

function runtimeCapabilityCall(details: TypeScriptDetails): CapabilityCall | undefined {
  if (!details.traces || details.tracesTruncated) {
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
  args?: ToolCallArgs;
  isError?: boolean;
  executionStarted?: boolean;
  state?: unknown;
  invalidate?: () => void;
}

function renderInputSection(context: ToolResultContext, theme: RenderTheme): string {
  if (!context.args || Object.keys(context.args).length === 0) return "";
  const inputs = renderTypeScriptInputs(context.args, theme, {
    ...context,
    expanded: true,
    argsComplete: true,
  });
  return `\n\n${theme.bold(theme.fg("toolTitle", "Inputs"))}\n${inputs}`;
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
  if (value === null) return "Returned null";
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
  context: ToolResultContext;
}) {
  const rawMessage =
    input.details?.failure?.rootError || input.fallback || "TypeScript execution failed";
  const message = displayedFailure(rawMessage, input.expanded);
  const label =
    input.details?.failure?.kind === "cancelled"
      ? "Cancelled"
      : input.details?.failure?.kind === "timeout"
        ? "Timed out"
        : "Failed";
  let text = `${input.expanded ? "\n" : ""}${input.theme.bold(
    input.theme.fg("error", `✗ ${label}`) + input.theme.fg("dim", ` (${input.duration})`),
  )}`;
  text += `\n${input.theme.fg("error", message)}`;
  if (input.expanded) {
    const path = input.details?.failure?.functionPath ?? [];
    if (path.length > 0) {
      text += `\n${input.theme.fg("toolTitle", "Function path")}\n${input.theme.fg("muted", displayedFunctionPath(path))}`;
    }
    text += renderInputSection(input.context, input.theme);
    text += renderExecutionDetails(input.details, input.theme);
  }
  return new Text(sanitizeTerminalText(text, { preserveSgr: true }), 0, 0);
}

function renderStructuredToolValue(input: {
  details?: TypeScriptDetails;
  fallback: string;
  theme: RenderTheme;
  context: ToolResultContext;
}): ResultRenderingState {
  const { details, fallback, theme, context } = input;
  if (!(details && !details.truncated && Object.hasOwn(details, "value"))) {
    return {
      lines: fallback ? highlightCode(fallback, "typescript") : [],
      hangingIndents: {},
    };
  }
  if (details.value === undefined) {
    return { lines: highlightCode("undefined", "typescript"), hangingIndents: {} };
  }
  const source = typeof context.args?.code === "string" ? context.args.code : "";
  const capabilityCall = details.traces
    ? runtimeCapabilityCall(details)
    : inferCapabilityCall(source);
  const structuredResult = renderResultValue(details.value, theme, capabilityCall);
  if (structuredResult) {
    return {
      lines: structuredResult.detailLines ?? structuredResult.lines,
      hangingIndents:
        structuredResult.detailHangingIndents ?? structuredResult.hangingIndents ?? {},
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

function executionNotices(details: TypeScriptDetails | undefined, outcome: string): string[] {
  const notices: string[] = [];
  const failed = details?.traces?.some(
    (entry) => entry.status === "failed" || entry.status === "rejected",
  );
  const nonzero = details?.progress?.some(
    (entry) => entry.status === "done" && entry.code !== undefined && entry.code !== 0,
  );
  if (failed) notices.push("execution had failures");
  else if (nonzero && outcome !== "error") notices.push("nonzero exits recorded");
  if (details?.tracesTruncated || details?.progressTruncated)
    notices.push("execution history incomplete");
  return notices;
}

function renderExecutionDetails(
  details: TypeScriptDetails | undefined,
  theme: RenderTheme,
  returnedLines: string[] = [],
): string {
  let text = "";
  // Error and upstream-truncated views may not display details.value at all.
  const returnedValue =
    returnedLines.length > 0 && !details?.truncated ? details?.value : undefined;
  const retained = renderRetainedShellOutput(details, theme, returnedLines, returnedValue);
  if (retained)
    text += `\n\n${theme.bold(theme.fg("toolTitle", "Retained process output (tails)"))}${retained}`;
  const dashboard = renderExecutionDashboard(details, theme, true);
  if (dashboard)
    text += `\n\n${theme.bold(theme.fg("toolTitle", "Execution (call completion)"))}${dashboard}`;
  if (details?.truncated)
    text += `\n${theme.fg("warning", "Output was truncated before rendering; omitted data is unavailable here.")}`;
  return text;
}

function renderCompletedToolResult(input: {
  expanded: boolean;
  details?: TypeScriptDetails;
  fallback: string;
  duration: string;
  theme: RenderTheme;
  rendering: ResultRenderingState;
  context: ToolResultContext;
}) {
  const { expanded, details, fallback, duration, theme, rendering } = input;
  const shown = expanded ? rendering.lines : [];
  const state = details?.truncated ? `truncated, ${duration}` : duration;
  const resultLabel = describeResult(
    details?.value,
    rendering.structuredResult,
    details?.truncated === true,
    details && Object.hasOwn(details, "value") ? "" : fallback,
  );
  const leafOutcome = rendering.structuredResult?.outcome ?? "success";
  const notices = executionNotices(details, leafOutcome);
  const resultOutcome =
    leafOutcome === "error"
      ? "error"
      : details?.truncated || notices.length > 0
        ? "warning"
        : leafOutcome;
  const resultMarker = theme.fg(
    resultOutcome,
    { success: "✓ ", warning: "⚠ ", error: "✗ " }[resultOutcome],
  );
  let text = `${expanded ? "\n" : ""}${theme.bold(
    resultMarker +
      theme.fg("toolTitle", resultLabel) +
      notices.map((notice) => theme.fg("warning", ` · ${notice}`)).join("") +
      theme.fg(resultOutcome === "success" ? "dim" : resultOutcome, ` (${state})`),
  )}`;
  const resultContentStart = text.split("\n").length;
  if (expanded && shown.length > 0) {
    text += `\n${shown.join("\n")}`;
  } else if (expanded) {
    text += `\n${theme.fg("dim", "(no result)")}`;
  }
  if (expanded) {
    text += renderInputSection(input.context, theme);
    text += renderExecutionDetails(details, theme, rendering.lines);
  }
  text = sanitizeTerminalText(text, { preserveSgr: true });
  const displayedHangingIndents = Object.fromEntries(
    Object.entries(rendering.hangingIndents)
      .filter(([index]) => Number(index) < shown.length)
      .map(([index, width]) => [resultContentStart + Number(index), width]),
  );
  return Object.keys(displayedHangingIndents).length > 0
    ? new HangingIndentText(text, displayedHangingIndents)
    : new Text(text, 0, 0);
}

function renderToolResult(
  result: ToolResultLike,
  options: { expanded: boolean; isPartial: boolean },
  theme: RenderTheme,
  context: ToolResultContext,
) {
  const fallback = result.content
    .filter((content) => content.type === "text")
    .map((content) => content.text ?? "")
    .join("\n");
  const details = isRecord(result.details)
    ? (result.details as unknown as TypeScriptDetails)
    : undefined;
  const execution = executionTiming(context, !options.isPartial || context.isError === true);
  for (const key of ["traces", "progress", "functions"] as const) {
    if (details?.[key] !== undefined && !Array.isArray(details[key]))
      throw new Error("Invalid execution metadata");
  }
  if (options.isPartial && !context.isError) {
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
      context,
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
    context,
  });
}

export function renderTypeScriptToolResult(
  result: ToolResultLike,
  options: { expanded: boolean; isPartial: boolean },
  theme: RenderTheme,
  context: ToolResultContext,
) {
  try {
    return renderToolResult(result, options, theme, context);
  } catch {
    const content = result.content
      .filter((entry) => entry.type === "text")
      .map((entry) => entry.text ?? "")
      .join("\n");
    const heading = context.isError
      ? "✗ Failed — structured view unavailable"
      : "⚠ Structured view unavailable";
    const retained = options.expanded
      ? [
          content,
          ...renderJson(result.details),
          ...(context.args ? ["Inputs", ...renderJson(context.args)] : []),
        ]
          .filter(Boolean)
          .join("\n")
      : `${content.split("\n")[0] ?? ""}\nExpand to inspect retained data.`;
    return new Text(sanitizeTerminalText(`${heading}\n${retained}`, { preserveSgr: true }), 0, 0);
  }
}
