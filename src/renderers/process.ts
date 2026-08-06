import { sanitizeTerminalText } from "../shared/text-sanitization.js";
import { hasOnlyKeys, isRecord } from "./shared.js";
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

  const statusColor = value.code === 0 ? "success" : "error";
  const suffix = value.truncated ? theme.fg("warning", ", truncated") : "";
  const lines = [
    `${theme.fg("toolTitle", theme.bold("shell"))} ${theme.fg(statusColor, `exit ${value.code}`)}${suffix}`,
  ];
  if (stdout) {
    lines.push(theme.fg("accent", "stdout"), ...stdout.split("\n"));
  }
  if (stderr) {
    lines.push(theme.fg("warning", "stderr"), ...stderr.split("\n"));
  }
  if (!stdout && !stderr) {
    lines.push(theme.fg("dim", "(no output)"));
  }
  return {
    kind: "shell",
    lines,
    summary: `exit ${value.code}${value.truncated ? ", truncated" : ""}`,
    detailLines: lines.slice(1),
  };
}
