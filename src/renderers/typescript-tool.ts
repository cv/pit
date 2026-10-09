import { highlightCode } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { formatDuration } from "../execution/timings.js";
import { isRecord } from "../shared/records.js";
import { shapeGuard } from "../shared/shape-guard.js";
import { sanitizeTerminalText } from "../shared/text-sanitization.js";
import { ensureRendererState, type WithRendererState } from "../tool/renderer-state.js";
import { executionTiming } from "../tool/timing.js";
import { inferFunctionCall, runtimeFunctionCall } from "./function-call.js";
import { renderResultValue } from "./generic.js";
import { HangingIndentText } from "./hanging-indent-text.js";
import { describeResult } from "./result-summary.js";
import { offsetHangingIndents, outcomeMarker, renderJson } from "./shared.js";
import type { RenderedResultValue } from "./types.js";
import { displayedFailure, displayedFunctionPath } from "./typescript-failure.js";
import { renderPartialToolResult } from "./typescript-progress.js";
import {
  executionNotices,
  renderExecutionDetails,
  type RenderTheme,
  retainsValue,
  type TypeScriptDetails,
} from "./typescript-result-details.js";
import { renderTypeScriptInputs, type ToolCallArgs } from "./typescript-tool-call.js";

// Collapsed results name this many attached images; expanded results list all of them.
const COLLAPSED_IMAGES = 3;

type ResultOutcome = NonNullable<RenderedResultValue["outcome"]>;

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
  const recoverable = input.details?.recoverable;
  if (recoverable && typeof recoverable.toolCallId === "string") {
    // What the program consumed before failing is retained; say how to get it back.
    const kept =
      recoverable.calls === 1 ? "1 completed call" : `${recoverable.calls} completed calls`;
    const lost = recoverable.omitted > 0 ? ` · ${recoverable.omitted} not kept` : "";
    text += `\n${input.theme.fg("warning", `↺ Recoverable: ${kept}${lost}`)}`;
    text += `\n${input.theme.fg("dim", `runtime.completedCalls(${JSON.stringify(recoverable.toolCallId)})`)}`;
  }
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
  const functionCall = details.traces ? runtimeFunctionCall(details) : inferFunctionCall(source);
  const structuredResult = renderResultValue(details.value, theme, functionCall, input.expanded);
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

/** The result headline: an attached-image count, or the summary of the returned value. */
function resultLabel(
  details: TypeScriptDetails | undefined,
  rendering: ResultRenderingState,
  fallback: string,
  expanded: boolean,
): string {
  const images = details?.imageAttachments?.length ?? 0;
  if (images > 0 && details?.value === undefined) {
    return images === 1 ? "Image attached" : `${images} images attached`;
  }
  return describeResult(details?.value, rendering.structuredResult, {
    unretained: details?.truncated === true && !retainsValue(details),
    fallback: details && Object.hasOwn(details, "value") ? "" : fallback,
    expanded,
  });
}

/** The parenthesized state: duration, preceded by truncation unless the value reports it. */
function resultState(
  details: TypeScriptDetails | undefined,
  rendering: ResultRenderingState,
  duration: string,
): string {
  // Domain values that own a truncated flag already report it in their summary; say it once.
  const reportedByValue =
    rendering.structuredResult !== undefined &&
    rendering.structuredResult.kind !== "compound" &&
    isRecord(details?.value) &&
    details.value.truncated === true;
  return details?.truncated && !reportedByValue ? `truncated, ${duration}` : duration;
}

/** A failed value stays an error; truncation or execution notices raise success to a warning. */
function resultOutcome(
  leafOutcome: ResultOutcome,
  details: TypeScriptDetails | undefined,
  notices: string[],
): ResultOutcome {
  if (leafOutcome === "error") return "error";
  return details?.truncated || notices.length > 0 ? "warning" : leafOutcome;
}

function collapsedImages(
  images: NonNullable<TypeScriptDetails["imageAttachments"]>,
  theme: RenderTheme,
): string {
  let text = "";
  for (const { file, mimeType } of images.slice(0, COLLAPSED_IMAGES))
    text += `\nImage: ${file} (${mimeType})`;
  const hidden = images.length - COLLAPSED_IMAGES;
  if (hidden > 0)
    text += `\n${theme.fg("dim", `… ${hidden} more image${hidden === 1 ? "" : "s"}; expand to list`)}`;
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
  const { expanded, details, theme, rendering } = input;
  const leafOutcome = rendering.structuredResult?.outcome ?? "success";
  const notices = executionNotices(details, leafOutcome);
  const outcome = resultOutcome(leafOutcome, details, notices);
  const header = theme.bold(
    `${outcomeMarker(theme, outcome)} ` +
      theme.fg("toolTitle", resultLabel(details, rendering, input.fallback, expanded)) +
      notices.map((notice) => theme.fg("warning", ` · ${notice}`)).join("") +
      theme.fg(
        outcome === "success" ? "dim" : outcome,
        ` (${resultState(details, rendering, input.duration)})`,
      ),
  );
  let text = `${expanded ? "\n" : ""}${header}`;
  const resultContentStart = text.split("\n").length;
  if (expanded) {
    text += `\n${rendering.lines.length > 0 ? rendering.lines.join("\n") : theme.fg("dim", "(no result)")}`;
    text += renderInputSection(input.context, theme);
    text += renderExecutionDetails(details, theme, rendering.lines);
  } else {
    text += collapsedImages(details?.imageAttachments ?? [], theme);
  }
  const displayedHangingIndents = offsetHangingIndents(rendering.hangingIndents, {
    lines: resultContentStart,
    before: expanded ? rendering.lines.length : 0,
  });
  return new HangingIndentText(
    sanitizeTerminalText(text, { preserveSgr: true }),
    displayedHangingIndents,
  );
}

const Duration = Type.Number({ minimum: 0 });

/**
 * The execution metadata the renderer reads before trusting details. Pi supplies unknown details;
 * any other shape uses the lossless raw fallback.
 */
const hasRenderableMetadata = shapeGuard(
  Type.Object({
    timings: Type.Optional(
      Type.Object({ totalMs: Duration, phases: Type.Record(Type.String(), Duration) }),
    ),
    traces: Type.Optional(Type.Array(Type.Object({ namespace: Type.String() }))),
    progress: Type.Optional(Type.Array(Type.Unknown())),
    functions: Type.Optional(Type.Array(Type.Unknown())),
    imageAttachments: Type.Optional(
      Type.Array(
        Type.Object({
          file: Type.String(),
          mimeType: Type.String(),
          note: Type.String(),
          omitted: Type.Optional(Type.Boolean()),
        }),
      ),
    ),
  }),
);

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
  if (rawDetails && !hasRenderableMetadata(rawDetails)) {
    throw new Error("Invalid execution metadata");
  }
  const details = rawDetails as TypeScriptDetails | undefined;
  const recordedMs = details?.timings?.totalMs;
  if ((!options.isPartial || context.isError) && recordedMs !== undefined) {
    execution.duration = formatDuration(recordedMs);
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
