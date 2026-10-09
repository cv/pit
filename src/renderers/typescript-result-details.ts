import { formatDuration } from "../execution/timings.js";
import type { ExecutionProgressSnapshot } from "../execution/types.js";
import type { FunctionActivity } from "../functions/core.js";
import type { RecoverableCalls, StructuredTypeScriptFailure } from "../tool/failure-context.js";
import { renderExecutionDashboard } from "./execution-dashboard.js";
import { renderRetainedShellOutput } from "./typescript-progress.js";

export interface TypeScriptDetails extends ExecutionProgressSnapshot {
  value: unknown;
  truncated: boolean;
  functions?: FunctionActivity[];
  failure?: StructuredTypeScriptFailure;
  recoverable?: RecoverableCalls;
  imageAttachments?: Array<{ file: string; mimeType: string; note: string; omitted?: boolean }>;
}

/**
 * Whether details retain the returned value. Truncated results keep a fitted value; older
 * sessions and unstructured fallbacks kept only the model-visible text.
 */
export function retainsValue(details: TypeScriptDetails | undefined): details is TypeScriptDetails {
  return (
    details !== undefined &&
    Object.hasOwn(details, "value") &&
    !(details.truncated && details.value === undefined)
  );
}

export interface RenderTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export function executionNotices(
  details: TypeScriptDetails | undefined,
  outcome: string,
): string[] {
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
  const omittedImages = details?.imageAttachments?.filter(({ omitted }) => omitted).length ?? 0;
  if (omittedImages > 0)
    notices.push(`${omittedImages === 1 ? "image" : "images"} omitted for text-only model`);

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
  return `\n\n${theme.fg("muted", `${total}: ${ranking.join(", ")}`)}`;
}

export function renderExecutionDetails(
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
  if (details?.imageAttachments?.length) {
    const images = details.imageAttachments.map(
      ({ file, mimeType, note }) => `${file} (${mimeType})${note ? `\n${note}` : ""}`,
    );
    text += `\n\n${theme.bold(theme.fg("toolTitle", "Images"))}\n${images.join("\n")}`;
  }

  if (details?.truncated)
    text += `\n${theme.fg("warning", "Result truncated to fit the output budget; omitted parts are not retained.")}`;
  return text;
}
