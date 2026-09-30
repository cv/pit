import { Type } from "typebox";

import { CLOSED, shapeGuard } from "../shared/shape-guard.js";
import { renderArrayCompound, renderCompound, renderMultilineText } from "./compound.js";
import { renderContextOutline, renderContextReceipt, renderNoteListing } from "./context-result.js";
import { type FunctionCall, functionResultRenderer } from "./function-call.js";
import { renderGhResult } from "./gh-result.js";
import { GIT_RESULT_RENDERERS } from "./git-result.js";
import { renderHttp } from "./http.js";
import { NPM_RESULT_RENDERERS } from "./npm-result.js";
import { renderShell } from "./process.js";
import {
  combinedOutcome,
  indent,
  offsetHangingIndents,
  outcomeMarker,
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

/** Direct namespace results route here before shape-based fallback rendering. */
const FUNCTION_RESULT_RENDERERS = {
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

/** Each entry's value is rendered on its own, so the batch shape leaves it unconstrained. */
const isBatchResult = shapeGuard(
  Type.Object(
    {
      results: Type.Array(
        Type.Union([
          Type.Object(
            {
              kind: Type.Union([Type.Literal("read"), Type.Literal("edit")]),
              index: Type.Number(),
              ok: Type.Literal(true),
              value: Type.Unknown(),
            },
            CLOSED,
          ),
          Type.Object(
            {
              kind: Type.Literal("read"),
              index: Type.Number(),
              ok: Type.Literal(false),
              value: Type.Optional(Type.Undefined()),
              error: Type.String(),
            },
            CLOSED,
          ),
        ]),
      ),
    },
    CLOSED,
  ),
);

function renderBatch(value: unknown, context: RenderContext): RenderedResultValue | undefined {
  if (!isBatchResult(value)) return;

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
    if (!entry.ok) {
      lines.push(`${outcomeMarker(context.theme, "error")} [${entry.index}] ${entry.kind}`);
      lines.push(context.theme.fg("error", `  ${entry.error}`));
      continue;
    }
    const nested = renderValueWithFallback(entry.value, { ...context, depth: context.depth + 1 });
    lines.push(
      `${outcomeMarker(context.theme, nested.outcome ?? "success")} [${entry.index}] ${entry.kind}`,
    );
    children.push(nested);
    Object.assign(
      hangingIndents,
      offsetHangingIndents(nested.hangingIndents, { lines: lines.length, columns: 2 }),
    );
    lines.push(...indent(nested.lines));
  }
  return {
    kind: "batch",
    lines,
    summary,
    outcome: failed ? "error" : combinedOutcome(children),
    detailLines: lines.slice(1),
    hangingIndents,
    detailHangingIndents: offsetHangingIndents(hangingIndents, { lines: -1 }),
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
  renderContextReceipt,
  renderContextOutline,
  renderNoteListing,
  renderMultilineText,
];

function renderKnownValue(value: unknown, context: RenderContext): RenderedResultValue | undefined {
  if (context.functionCall) {
    const rendererName = functionResultRenderer(context.functionCall);
    const renderer = rendererName ? FUNCTION_RESULT_RENDERERS[rendererName] : undefined;
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
  return (
    renderKnownValue(value, context) || {
      kind: "json",
      lines: context.details === false ? [] : renderJson(value),
    }
  );
}

export function renderResultValue(
  value: unknown,
  theme: ResultTheme,
  functionCall?: FunctionCall,
  details = true,
): RenderedResultValue | undefined {
  return renderKnownValue(value, {
    theme,
    seen: new WeakSet(),
    depth: 0,
    details,
    ...(functionCall ? { functionCall } : {}),
  });
}
