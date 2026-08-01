import type { RenderContext, RenderedResultValue } from "../result-renderer-types.js";
import { hasOnlyKeys, isRecord } from "./shared.js";

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

  const statusColor = value.code === 0 ? "success" : "error";
  const suffix = value.truncated ? theme.fg("warning", ", truncated") : "";
  const lines = [
    `${theme.fg("toolTitle", theme.bold("shell"))} ${theme.fg(statusColor, `exit ${value.code}`)}${suffix}`,
  ];
  if (value.stdout) {
    lines.push(theme.fg("accent", "stdout"), ...value.stdout.split("\n"));
  }
  if (value.stderr) {
    lines.push(theme.fg("warning", "stderr"), ...value.stderr.split("\n"));
  }
  if (!value.stdout && !value.stderr) {
    lines.push(theme.fg("dim", "(no output)"));
  }
  return {
    kind: "shell",
    lines,
    summary: `exit ${value.code}${value.truncated ? ", truncated" : ""}`,
    detailLines: lines.slice(1),
  };
}
