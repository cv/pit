import { type CapabilityCall, capabilityResultRenderer } from "../capability-presentation.js";
import { renderGhResult } from "../gh-result-renderer.js";
import { GIT_RESULT_RENDERERS } from "../git-result-renderers.js";
import { NPM_RESULT_RENDERERS } from "../npm-result-renderers.js";
import type {
  RenderContext,
  RenderedResultValue,
  ResultRendererKey,
  ResultTheme,
  ValueRenderer,
} from "../result-renderer-types.js";
import { sanitizeTerminalText } from "../text-sanitization.js";
import { renderHttp } from "./http.js";
import { renderShell } from "./process.js";
import {
  hasOnlyKeys,
  indent,
  isRecord,
  type JsonRecord,
  MAX_RECURSIVE_DEPTH,
  plural,
  renderJson,
} from "./shared.js";
import {
  renderEdit,
  renderGlob,
  renderRead,
  renderSearch,
  renderStat,
  renderWorkspaceList,
} from "./workspace.js";

export type { RenderedResultValue } from "../result-renderer-types.js";

/** Direct capability results route here before shape-based fallback rendering. */
const CAPABILITY_RESULT_RENDERERS = {
  read: renderRead,
  edit: renderEdit,
  batch: renderBatch,
  list: renderWorkspaceList,
  glob: renderGlob,
  search: renderSearch,
  stat: renderStat,
  shell: renderShell,
  http: renderHttp,
  gh: renderGhResult,
  "git.status": GIT_RESULT_RENDERERS.status,
  "git.diff": GIT_RESULT_RENDERERS.diff,
  "git.log": GIT_RESULT_RENDERERS.log,
  "git.add": GIT_RESULT_RENDERERS.add,
  "git.commit": GIT_RESULT_RENDERERS.commit,
  "git.show": GIT_RESULT_RENDERERS.show,
  "git.push": GIT_RESULT_RENDERERS.push,
  "git.tag": GIT_RESULT_RENDERERS.tag,
  "npm.run": NPM_RESULT_RENDERERS.run,
  "npm.test": NPM_RESULT_RENDERERS.test,
  "npm.install": NPM_RESULT_RENDERERS.install,
  "npm.audit": NPM_RESULT_RENDERERS.audit,
  "npm.outdated": NPM_RESULT_RENDERERS.outdated,
  "npm.pack": NPM_RESULT_RENDERERS.pack,
} as const satisfies Record<ResultRendererKey, ValueRenderer>;

function isBatchEntry(value: unknown): value is JsonRecord {
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    !["read", "edit"].includes(value.kind) ||
    typeof value.index !== "number" ||
    typeof value.ok !== "boolean"
  ) {
    return false;
  }
  if (value.ok) {
    return hasOnlyKeys(value, ["kind", "index", "ok", "value"]);
  }
  return (
    value.kind === "read" &&
    hasOnlyKeys(value, ["kind", "index", "ok", "error"], ["value"]) &&
    typeof value.error === "string" &&
    value.value === undefined
  );
}

function renderBatch(value: unknown, context: RenderContext): RenderedResultValue | undefined {
  if (
    !(
      isRecord(value) &&
      hasOnlyKeys(value, ["results"]) &&
      Array.isArray(value.results) &&
      value.results.every(isBatchEntry)
    )
  ) {
    return;
  }

  const succeeded = value.results.filter((entry) => entry.ok).length;
  const failed = value.results.length - succeeded;
  const summary = [
    plural(value.results.length, "operation"),
    `${succeeded} succeeded`,
    failed ? `${failed} failed` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const lines = [
    `${context.theme.fg("toolTitle", context.theme.bold("batch"))} ${context.theme.fg(failed ? "warning" : "dim", `(${summary})`)}`,
  ];
  for (const entry of value.results) {
    const status = entry.ok ? context.theme.fg("success", "✓") : context.theme.fg("error", "✗");
    lines.push(`${status} [${entry.index}] ${entry.kind}`);
    if (entry.ok) {
      const nested = renderValueWithFallback(entry.value, {
        ...context,
        depth: context.depth + 1,
      });
      lines.push(...indent(nested.lines));
    } else {
      lines.push(context.theme.fg("error", `  ${entry.error}`));
    }
  }
  return { kind: "batch", lines, summary, detailLines: lines.slice(1) };
}

function renderMultilineText(
  value: unknown,
  _context: RenderContext,
): RenderedResultValue | undefined {
  if (typeof value !== "string" || !(value.includes("\n") || value.includes("\r"))) {
    return;
  }
  const lines = sanitizeTerminalText(value.replace(/\r\n?/g, "\n")).split("\n");
  return {
    kind: "text",
    lines,
    summary: plural(lines.length, "line"),
    detailLines: lines,
  };
}

const VALUE_RENDERERS: ValueRenderer[] = [
  renderShell,
  renderRead,
  renderSearch,
  renderEdit,
  renderGlob,
  renderHttp,
  renderBatch,
  renderStat,
  renderWorkspaceList,
  renderMultilineText,
  renderArrayCompound,
];

function safeSectionLabel(value: string): string {
  return sanitizeTerminalText(value).replace(/\s+/g, " ").trim() || "(unnamed)";
}

function renderCompound(value: unknown, context: RenderContext): RenderedResultValue | undefined {
  if (!isRecord(value) || context.depth >= MAX_RECURSIVE_DEPTH || context.seen.has(value)) {
    return;
  }
  context.seen.add(value);

  const recognized: Array<[string, RenderedResultValue]> = [];
  const remaining: JsonRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    const rendered = renderKnownValue(entry, { ...context, depth: context.depth + 1 });
    if (rendered) {
      recognized.push([key, rendered]);
    } else {
      remaining[key] = entry;
    }
  }
  if (recognized.length === 0) {
    return;
  }

  const lines: string[] = [];
  const hangingIndents: Record<number, number> = {};
  for (const [key, rendered] of recognized) {
    if (lines.length > 0) {
      lines.push("");
    }
    const description = [rendered.kind, rendered.summary].filter(Boolean).join(", ");
    const detailLines = rendered.detailLines ?? rendered.lines;
    const detailStart = lines.length + 1;
    lines.push(
      `${context.theme.fg("accent", context.theme.bold(safeSectionLabel(key)))} ${context.theme.fg("dim", `(${description})`)}`,
      ...indent(detailLines),
    );
    const detailHangingIndents = rendered.detailHangingIndents ?? rendered.hangingIndents ?? {};
    for (const [index, width] of Object.entries(detailHangingIndents)) {
      hangingIndents[detailStart + Number(index)] = width + 2;
    }
  }
  if (Object.keys(remaining).length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(
      context.theme.fg("accent", context.theme.bold("other")),
      ...indent(renderJson(remaining)),
    );
  }
  return {
    kind: "compound",
    lines,
    summary: plural(recognized.length, "section"),
    detailLines: lines,
    hangingIndents,
    detailHangingIndents: hangingIndents,
  };
}

function renderArrayCompound(
  value: unknown,
  context: RenderContext,
): RenderedResultValue | undefined {
  if (!Array.isArray(value) || context.depth >= MAX_RECURSIVE_DEPTH || context.seen.has(value)) {
    return;
  }
  context.seen.add(value);
  const renderedEntries = value.map((entry) =>
    renderKnownValue(entry, { ...context, depth: context.depth + 1 }),
  );
  if (!renderedEntries.some((entry) => entry !== undefined)) {
    return;
  }

  const lines: string[] = [];
  const hangingIndents: Record<number, number> = {};
  for (const [index, entry] of value.entries()) {
    if (lines.length > 0) {
      lines.push("");
    }
    const rendered = renderedEntries[index] ?? { kind: "json", lines: renderJson(entry) };
    const description = [rendered.kind, rendered.summary].filter(Boolean).join(", ");
    const detailLines = rendered.detailLines ?? rendered.lines;
    const detailStart = lines.length + 1;
    lines.push(
      `${context.theme.fg("accent", context.theme.bold(`[${index}]`))} ${context.theme.fg("dim", `(${description})`)}`,
      ...indent(detailLines),
    );
    const detailHangingIndents = rendered.detailHangingIndents ?? rendered.hangingIndents ?? {};
    for (const [lineIndex, width] of Object.entries(detailHangingIndents)) {
      hangingIndents[detailStart + Number(lineIndex)] = width + 2;
    }
  }
  return {
    kind: "array",
    lines,
    summary: plural(value.length, "item"),
    detailLines: lines,
    hangingIndents,
    detailHangingIndents: hangingIndents,
  };
}

function renderKnownValue(value: unknown, context: RenderContext): RenderedResultValue | undefined {
  if (context.depth === 0 && context.capabilityCall) {
    const rendererName = capabilityResultRenderer(context.capabilityCall);
    const renderer = rendererName ? CAPABILITY_RESULT_RENDERERS[rendererName] : undefined;
    const rendered = renderer?.(value, context);
    if (rendered) {
      return rendered;
    }
  }

  for (const renderer of VALUE_RENDERERS) {
    const rendered = renderer(value, context);
    if (rendered) {
      return rendered;
    }
  }
  return renderCompound(value, context);
}

function renderValueWithFallback(value: unknown, context: RenderContext): RenderedResultValue {
  return renderKnownValue(value, context) || { kind: "json", lines: renderJson(value) };
}

export function renderResultValue(
  value: unknown,
  theme: ResultTheme,
  capabilityCall?: CapabilityCall,
): RenderedResultValue | undefined {
  return renderKnownValue(value, {
    theme,
    seen: new WeakSet(),
    depth: 0,
    ...(capabilityCall ? { capabilityCall } : {}),
  });
}
