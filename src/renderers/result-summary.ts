import { visibleWidth } from "@earendil-works/pi-tui";

import { parseProcessResult } from "../process/results.js";
import { sanitizeTerminalText } from "../shared/text-sanitization.js";
import { plural } from "./shared.js";
import type { RenderedResultValue } from "./types.js";

/** Only complete, small scalar values qualify; expansion always retains the original. */
function inlineValue(value: unknown): string | undefined {
  if (!["string", "number", "boolean"].includes(typeof value)) return;
  if (typeof value === "string" && (value.length > 120 || /[\r\n\t]/.test(value))) return;
  if (typeof value === "number" && !Number.isFinite(value)) return;
  const text = sanitizeTerminalText(JSON.stringify(value));
  return visibleWidth(text) <= 60 ? text : undefined;
}

export function describeResult(
  value: unknown,
  structured: RenderedResultValue | undefined,
  options: { truncated: boolean; fallback: string; expanded: boolean },
): string {
  const { truncated, fallback, expanded } = options;
  if (truncated) {
    return "Truncated output";
  }
  if (structured) {
    let summary = structured.summary ? ` ${structured.summary}` : "";
    const process =
      !expanded && structured.kind === "shell" ? parseProcessResult(value) : undefined;
    if (process && !process.truncated && !process.stderr && process.stdout) {
      const preview = inlineValue(process.stdout.replace(/\r?\n$/, ""));
      if (preview !== undefined) summary += ` · stdout: ${preview}`;
    }
    const verbs: Record<string, string> = {
      read: "Read",
      reads: "Read",
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
    return `Returned ${plural(value.length, "item")}`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    const names = keys.slice(0, 3).join(", ");
    return `Returned ${plural(keys.length, "field")}${names ? `: ${names}` : ""}`;
  }
  const preview = expanded ? undefined : inlineValue(value);
  return `Returned ${typeof value}${preview === undefined ? "" : `: ${preview}`}`;
}
