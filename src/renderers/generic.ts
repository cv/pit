import { type CapabilityCall, capabilityResultRenderer } from "./capability.js";
import { renderArrayCompound, renderCompound, renderMultilineText } from "./compound.js";
import { renderGhResult } from "./gh-result.js";
import { GIT_RESULT_RENDERERS } from "./git-result.js";
import { renderHttp } from "./http.js";
import { NPM_RESULT_RENDERERS } from "./npm-result.js";
import { renderShell } from "./process.js";
import {
  combinedOutcome,
  hasOnlyKeys,
  indent,
  isRecord,
  type JsonRecord,
  plural,
  renderJson,
} from "./shared.js";
import type {
  RenderContext,
  RenderedResultValue,
  ResultRendererKey,
  ResultTheme,
  ValueRenderer,
} from "./types.js";
import {
  renderEdit,
  renderGlob,
  renderRead,
  renderSearch,
  renderStat,
  renderWorkspaceList,
} from "./workspace.js";

export type { RenderedResultValue } from "./types.js";

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
  const hangingIndents: Record<number, number> = {};
  const children: RenderedResultValue[] = [];
  for (const entry of value.results) {
    const nested = entry.ok
      ? renderValueWithFallback(entry.value, {
          ...context,
          depth: context.depth + 1,
        })
      : undefined;
    const outcome = entry.ok ? (nested?.outcome ?? "success") : "error";
    const status = context.theme.fg(outcome, { success: "✓", warning: "⚠", error: "✗" }[outcome]);
    lines.push(`${status} [${entry.index}] ${entry.kind}`);
    if (nested) {
      children.push(nested);
      for (const [index, width] of Object.entries(nested.hangingIndents ?? {})) {
        hangingIndents[lines.length + Number(index)] = width + 2;
      }
      lines.push(...indent(nested.lines));
    } else {
      lines.push(context.theme.fg("error", `  ${entry.error}`));
    }
  }
  return {
    kind: "batch",
    lines,
    summary,
    outcome: failed ? "error" : combinedOutcome(children),
    detailLines: lines.slice(1),
    hangingIndents,
    detailHangingIndents: Object.fromEntries(
      Object.entries(hangingIndents).map(([index, width]) => [Number(index) - 1, width]),
    ),
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
];

function renderKnownValue(value: unknown, context: RenderContext): RenderedResultValue | undefined {
  if (context.capabilityCall) {
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
  return (
    renderArrayCompound(value, context, renderKnownValue) ??
    renderCompound(value, context, renderKnownValue)
  );
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
