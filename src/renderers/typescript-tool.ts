import { highlightCode } from "@earendil-works/pi-coding-agent";

import { formatDuration } from "../execution/timings.js";
import type { ExecutionProgressSnapshot } from "../execution/types.js";
import type { FunctionActivity } from "../functions/core.js";
import { sanitizeTerminalText } from "../shared/text-sanitization.js";
import type { StructuredTypeScriptFailure } from "../tool/failure-context.js";
import { ensureRendererState, type WithRendererState } from "../tool/renderer-state.js";
import { executionTiming } from "../tool/timing.js";
import { type CapabilityCall, inferCapabilityCall } from "./capability.js";
import { renderExecutionDashboard } from "./execution-dashboard.js";
import { renderResultValue } from "./generic.js";
import { HangingIndentText } from "./hanging-indent-text.js";
import { describeResult } from "./result-summary.js";
import { isRecord, offsetHangingIndents, outcomeMarker, renderJson } from "./shared.js";
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

/**
 * Whether details retain the returned value. Truncated results keep a fitted value; older
 * sessions and unstructured fallbacks kept only the model-visible text.
 */
function retainsValue(details: TypeScriptDetails | undefined): details is TypeScriptDetails {
  return (
    details !== undefined &&
    Object.hasOwn(details, "value") &&
    !(details.truncated && details.value === undefined)
  );
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
  argsComplete?: boolean;
  state?: unknown;
  invalidate?: () => void;
}

type StatefulResultContext = WithRendererState<ToolResultContext>;

function renderInputSection(context: StatefulResultContext, theme: RenderTheme): string {
  if (!context.args || Object.keys(context.args).length === 0) return "";
  const inputs = renderTypeScriptInputs(context.args, theme, {
    ...context,
    expanded: true,
    argsComplete: true,
  });
  return `\n\n${theme.bold(theme.fg("toolTitle", "Inputs"))}\n${inputs}`;
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
  context: StatefulResultContext;
}) {
  const rawMessage =
    input.details?.failure?.rootError || input.fallback || "TypeScript execution failed";
  const message = displayedFailure(rawMessage, input.expanded);
  const notExecuted =
    input.context.executionStarted === false &&
    input.context.argsComplete === false &&
    typeof input.context.args?.code !== "string" &&
    input.details === undefined;
  const label = notExecuted
    ? "Call interrupted — not executed"
    : input.details?.failure?.kind === "cancelled"
      ? "Cancelled"
      : input.details?.failure?.kind === "timeout"
        ? "Timed out"
        : "Failed";
  let text = `${input.expanded ? "\n" : ""}${input.theme.bold(
    input.theme.fg("error", `✗ ${label}`) +
      (notExecuted ? "" : input.theme.fg("dim", ` (${input.duration})`)),
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
  return new HangingIndentText(sanitizeTerminalText(text, { preserveSgr: true }));
}

function renderStructuredToolValue(input: {
  expanded: boolean;
  details?: TypeScriptDetails;
  fallback: string;
  theme: RenderTheme;
  context: StatefulResultContext;
}): ResultRenderingState {
  const { details, fallback, theme, context } = input;
  if (!retainsValue(details)) {
    return {
      lines: input.expanded && fallback ? highlightCode(fallback, "typescript") : [],
      hangingIndents: {},
    };
  }
  if (details.value === undefined) {
    return {
      lines: input.expanded ? highlightCode("undefined", "typescript") : [],
      hangingIndents: {},
    };
  }
  const source = typeof context.args?.code === "string" ? context.args.code : "";
  const capabilityCall = details.traces
    ? runtimeCapabilityCall(details)
    : inferCapabilityCall(source);
  const structuredResult = renderResultValue(details.value, theme, capabilityCall, input.expanded);
  if (structuredResult) {
    return {
      lines: structuredResult.detailLines ?? structuredResult.lines,
      hangingIndents:
        structuredResult.detailHangingIndents ?? structuredResult.hangingIndents ?? {},
      structuredResult,
    };
  }
  if (!input.expanded) return { lines: [], hangingIndents: {} };
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

function renderInvocationTiming(
  timings: ExecutionProgressSnapshot["timings"],
  theme: RenderTheme,
): string {
  if (!timings) return "";
  const phases = Object.entries(timings.phases).sort((left, right) => right[1] - left[1]);
  if (!phases.length) return "";

  // Show small breakdowns directly; summarize larger ones as the top two costs plus rest.
  const prominent = phases.length > 3 ? 2 : phases.length;
  const rest = phases.slice(prominent);
  const ranking = phases
    .slice(0, prominent)
    .map(([phase, value]) => `${formatDuration(value)} ${phase}`);
  if (rest.length) {
    const restMs = rest.reduce((sum, [, value]) => sum + value, 0);
    ranking.push(`${formatDuration(restMs)} rest`);
  }
  const total = `${formatDuration(timings.totalMs)} total`;
  return `\n\n${theme.fg("muted", `${total}   ${ranking.join(" › ")}`)}`;
}

function renderExecutionDetails(
  details: TypeScriptDetails | undefined,
  theme: RenderTheme,
  returnedLines: string[] = [],
): string {
  let text = "";
  // Error and unretained views may not display details.value at all.
  const returnedValue =
    returnedLines.length > 0 && retainsValue(details) ? details.value : undefined;
  const retained = renderRetainedShellOutput(details, theme, returnedValue);
  if (retained)
    text += `\n\n${theme.bold(theme.fg("toolTitle", "Retained process output (tails)"))}${retained}`;
  const dashboard = renderExecutionDashboard(details, theme, true, returnedValue);
  if (dashboard)
    text += `\n\n${theme.bold(theme.fg("toolTitle", "Execution (call completion)"))}${dashboard}`;
  text += renderInvocationTiming(details?.timings, theme);
  if (details?.truncated)
    text += `\n${theme.fg("warning", "Result truncated to fit the output budget; omitted parts are not retained.")}`;
  return text;
}

function renderCompletedToolResult(input: {
  expanded: boolean;
  details?: TypeScriptDetails;
  fallback: string;
  duration: string;
  theme: RenderTheme;
  rendering: ResultRenderingState;
  context: StatefulResultContext;
}) {
  const { expanded, details, fallback, duration, theme, rendering } = input;
  const shown = expanded ? rendering.lines : [];
  // Domain values that own a truncated flag already report it in their summary; say it once.
  const reportedByValue =
    rendering.structuredResult !== undefined &&
    rendering.structuredResult.kind !== "compound" &&
    isRecord(details?.value) &&
    details.value.truncated === true;
  const state = details?.truncated && !reportedByValue ? `truncated, ${duration}` : duration;
  const resultLabel = describeResult(details?.value, rendering.structuredResult, {
    unretained: details?.truncated === true && !retainsValue(details),
    fallback: details && Object.hasOwn(details, "value") ? "" : fallback,
    expanded,
  });
  const leafOutcome = rendering.structuredResult?.outcome ?? "success";
  const notices = executionNotices(details, leafOutcome);
  const resultOutcome =
    leafOutcome === "error"
      ? "error"
      : details?.truncated || notices.length > 0
        ? "warning"
        : leafOutcome;
  const resultMarker = `${outcomeMarker(theme, resultOutcome)} `;
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
  const displayedHangingIndents = offsetHangingIndents(rendering.hangingIndents, {
    lines: resultContentStart,
    before: shown.length,
  });
  return new HangingIndentText(text, displayedHangingIndents);
}

/** Pi supplies unknown details, including replayed entries. Validate once before rendering. */
function assertInvocationTimings(
  timings: unknown,
): asserts timings is ExecutionProgressSnapshot["timings"] {
  if (timings === undefined) return;
  if (
    !isRecord(timings) ||
    !isRecord(timings.phases) ||
    ![timings.totalMs, ...Object.values(timings.phases)].every(
      (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
    )
  ) {
    throw new Error("Invalid invocation timing metadata");
  }
}

function renderToolResult(
  result: ToolResultLike,
  options: { expanded: boolean; isPartial: boolean },
  theme: RenderTheme,
  context: StatefulResultContext,
) {
  const fallback = result.content
    .filter((content) => content.type === "text")
    .map((content) => content.text ?? "")
    .join("\n");
  const rawDetails = isRecord(result.details) ? result.details : undefined;
  const execution = executionTiming(context, !options.isPartial || context.isError === true);
  assertInvocationTimings(rawDetails?.timings);
  const details = rawDetails as unknown as TypeScriptDetails | undefined;
  const recordedMs = details?.timings?.totalMs;
  if ((!options.isPartial || context.isError) && recordedMs !== undefined) {
    execution.duration = formatDuration(recordedMs);
  }
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
    expanded: options.expanded,
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
    ensureRendererState(context);
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
    return new HangingIndentText(
      sanitizeTerminalText(`${heading}\n${retained}`, { preserveSgr: true }),
    );
  }
}
