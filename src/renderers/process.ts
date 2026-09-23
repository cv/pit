import { processOutputLines, semanticOutcome } from "../process/results.js";
import { sanitizeTerminalText } from "../shared/text-sanitization.js";
import { renderStructuredData } from "./compound.js";
import { hasOnlyKeys, isRecord, JSON_CONTAINER_PREFIX } from "./shared.js";
import type { RenderContext, RenderedResultValue } from "./types.js";

export function renderShell(
  value: unknown,
  { theme }: RenderContext,
): RenderedResultValue | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["stdout", "stderr", "code", "truncated"]) ||
    typeof value.stdout !== "string" ||
    typeof value.stderr !== "string" ||
    typeof value.code !== "number" ||
    typeof value.truncated !== "boolean"
  ) {
    return undefined;
  }

  const stdout = sanitizeTerminalText(value.stdout, { preserveSgr: true });
  const stderr = sanitizeTerminalText(value.stderr, { preserveSgr: true });

  const statusColor = semanticOutcome({
    stdout,
    stderr,
    code: value.code,
    truncated: value.truncated,
  });
  const suffix = value.truncated ? theme.fg("warning", ", truncated") : "";
  const lines = [
    `${theme.fg("toolTitle", theme.bold("shell"))} ${theme.fg(statusColor, `exit ${value.code}`)}${suffix}`,
  ];
  if (stdout) {
    let output = processOutputLines(stdout);
    if (!value.truncated && JSON_CONTAINER_PREFIX.test(stdout)) {
      try {
        output = renderStructuredData(JSON.parse(stdout), {
          theme,
          depth: 0,
          seen: new WeakSet(),
        }).lines;
      } catch {
        /* Incomplete JSON remains text. */
      }
    }
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
