import { processOutputLines, parseProcessResult, semanticOutcome } from "../process/results.js";
import { renderStructuredData } from "./compound.js";
import { isRecord } from "./shared.js";
import type { RenderContext, RenderedResultValue, ValueRenderer } from "./types.js";

const FAILED_STATES = new Set(["failure", "failed", "cancelled", "timed_out", "action_required"]);

function hasFailedDomainItem(value: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (Array.isArray(value)) return value.some((item) => hasFailedDomainItem(item, depth + 1));
  if (!isRecord(value)) return false;
  return (
    [value.conclusion, value.status, value.state].some(
      (state) => typeof state === "string" && FAILED_STATES.has(state.toLowerCase()),
    ) ||
    [value.jobs, value.statusCheckRollup].some((items) => hasFailedDomainItem(items, depth + 1))
  );
}

export const renderGhResult: ValueRenderer = (value, context: RenderContext) => {
  const result = parseProcessResult(value);
  if (!result) return;
  let parsed: unknown;
  if (!result.truncated) {
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      /* Preserve non-JSON output verbatim. */
    }
  }
  // gh.api accepts arbitrary shapes. A list/PR projection is never a lossless default.
  const output =
    parsed === undefined
      ? processOutputLines(result.stdout)
      : renderStructuredData(parsed, context).lines;
  const stderr = processOutputLines(result.stderr);
  const status = semanticOutcome(
    result,
    hasFailedDomainItem(parsed) ? { domainOutcome: "warning" } : {},
  );
  const lines = [
    `${context.theme.fg("toolTitle", context.theme.bold("gh"))} ${context.theme.fg(status, `exit ${result.code}`)}${result.truncated ? context.theme.fg("warning", ", truncated") : ""}`,
    ...output,
  ];
  if (stderr.length > 0) lines.push(context.theme.fg("warning", "stderr"), ...stderr);
  if (output.length === 0 && stderr.length === 0)
    lines.push(context.theme.fg("dim", "(no output)"));
  const count = Array.isArray(parsed) ? parsed.length : 1;
  return {
    kind: "gh",
    lines,
    outcome: status,
    summary: `${parsed === undefined ? `exit ${result.code}` : `${count} result${count === 1 ? "" : "s"}`}${result.truncated ? ", truncated" : ""}`,
    detailLines: [`exit: ${result.code}`, ...lines.slice(1)],
  } satisfies RenderedResultValue;
};
