import { nonemptyLines, parseProcessResult, semanticOutcome } from "../process/results.js";
import type { RenderContext, RenderedResultValue, ValueRenderer } from "./types.js";

function json(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    // Keep malformed or non-JSON CLI output as text.
  }
}
function itemLine(item: Record<string, unknown>): string {
  const id = item.number ?? item.databaseId ?? item.tagName ?? "";
  const title = item.title ?? item.name ?? "";
  const state = item.conclusion ?? item.status ?? item.state ?? "";
  const url = item.url ?? "";
  return [id ? `#${id}` : "", title, state ? `[${state}]` : "", url].filter(Boolean).join(" ");
}

const FAILED_STATES = new Set(["failure", "failed", "cancelled", "timed_out", "action_required"]);
function hasFailedDomainItem(value: unknown): boolean {
  const items = Array.isArray(value) ? value : [value];
  return items.some((item) => {
    if (!(item && typeof item === "object" && !Array.isArray(item))) {
      return false;
    }
    const record = item as Record<string, unknown>;
    return [record.conclusion, record.status, record.state].some(
      (state) => typeof state === "string" && FAILED_STATES.has(state.toLowerCase()),
    );
  });
}
export const renderGhResult: ValueRenderer = (value, context: RenderContext) => {
  const result = parseProcessResult(value);
  if (!result) {
    return;
  }
  const parsed = json(result.stdout);
  let output: string[];
  let count = 0;
  if (Array.isArray(parsed)) {
    count = parsed.length;
    output = parsed.map((x) =>
      x && typeof x === "object" ? itemLine(x as Record<string, unknown>) : String(x),
    );
  } else if (parsed && typeof parsed === "object") {
    count = 1;
    output = [
      itemLine(parsed as Record<string, unknown>),
      ...Object.entries(parsed as Record<string, unknown>)
        .filter(
          ([key]) =>
            ![
              "number",
              "databaseId",
              "title",
              "name",
              "state",
              "status",
              "conclusion",
              "url",
            ].includes(key),
        )
        .slice(0, 8)
        .map(
          ([key, val]) => `${key}: ${typeof val === "object" ? JSON.stringify(val) : String(val)}`,
        ),
    ];
  } else {
    output = nonemptyLines(result.stdout);
  }
  const stderr = nonemptyLines(result.stderr);
  const domainOutcome = hasFailedDomainItem(parsed) ? "warning" : undefined;
  const status = semanticOutcome(result, domainOutcome ? { domainOutcome } : {});
  const lines = [
    `${context.theme.fg("toolTitle", context.theme.bold("gh"))} ${context.theme.fg(status, `exit ${result.code}`)}${result.truncated ? context.theme.fg("warning", ", truncated") : ""}`,
    ...output,
  ];
  if (stderr.length > 0) {
    lines.push(context.theme.fg("warning", "stderr"), ...stderr);
  }
  if (output.length === 0 && stderr.length === 0) {
    lines.push(context.theme.fg("dim", "(no output)"));
  }
  return {
    kind: "gh",
    lines,
    outcome: status,
    summary: `${parsed ? `${count} result${count === 1 ? "" : "s"}` : `exit ${result.code}`}${result.truncated ? ", truncated" : ""}`,
    detailLines: lines.slice(1),
  } satisfies RenderedResultValue;
};
