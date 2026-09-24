import { parseProcessResult, processOutputLines, semanticOutcome } from "../process/results.js";
import { renderStructuredData } from "./compound.js";
import { parseCompleteJson } from "./shared.js";
import type { RenderContext, RenderedResultValue } from "./types.js";

export function renderShell(
  input: unknown,
  { theme }: RenderContext,
): RenderedResultValue | undefined {
  const value = parseProcessResult(input);
  if (!value) {
    return undefined;
  }
  const { stdout, stderr } = value;
  const statusColor = semanticOutcome(value);
  const suffix = value.truncated ? theme.fg("warning", ", truncated") : "";
  const lines = [
    `${theme.fg("toolTitle", theme.bold("shell"))} ${theme.fg(statusColor, `exit ${value.code}`)}${suffix}`,
  ];
  if (stdout) {
    // Incomplete, malformed, or scalar JSON stays text.
    const parsed = parseCompleteJson(stdout, {
      truncated: value.truncated,
      requireContainer: true,
    });
    const output =
      parsed === undefined
        ? processOutputLines(stdout)
        : renderStructuredData(parsed, { theme, depth: 0, seen: new WeakSet() }).lines;
    lines.push(theme.fg("accent", "stdout"), ...output);
  }
  if (stderr) {
    lines.push(theme.fg("warning", "stderr"), ...processOutputLines(stderr));
  }
  if (!stdout && !stderr) {
    lines.push(theme.fg("dim", "(no output)"));
  }
  return {
    kind: "shell",
    outcome: statusColor,
    lines,
    summary: `exit ${value.code}${value.truncated ? ", truncated" : ""}`,
    detailLines: lines.slice(1),
  };
}
