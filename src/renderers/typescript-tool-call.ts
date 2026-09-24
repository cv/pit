import { highlightCode } from "@earendil-works/pi-coding-agent";

import type { FunctionRegistry } from "../functions/core.js";
import { resolveSavedFunctionReferences } from "../functions/graph.js";
import { getNamedFunctionName } from "../functions/source.js";
import { sanitizeTerminalText } from "../shared/text-sanitization.js";
import { ensureRendererState, type WithRendererState } from "../tool/renderer-state.js";
import { formatTypeScriptSource } from "../tool/source-formatter.js";
import { generationTiming, type ToolCallTimingContext } from "../tool/timing.js";
import { describeCapabilityCall, inferCapabilityCall } from "./capability.js";
import { renderStructuredData } from "./compound.js";
import { HangingIndentText } from "./hanging-indent-text.js";

interface RenderTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface ToolCallArgs {
  label?: unknown;
  code?: unknown;
  functionId?: unknown;
  saveOnly?: unknown;
  params?: unknown;
  timeoutMs?: unknown;
}

interface ToolCallContext extends ToolCallTimingContext {
  expanded: boolean;
}

const SOURCE_FORMATTING_STATE = Symbol("pit-source-formatting");

interface SourceFormattingState {
  source: string;
  formatted?: string;
}

function formattedDisplaySource(code: string, context: WithRendererState<ToolCallContext>): string {
  if (!(code && context.argsComplete)) {
    return code;
  }
  const { state } = context;
  const current = (): SourceFormattingState | undefined =>
    state[SOURCE_FORMATTING_STATE] as SourceFormattingState | undefined;
  let formatting = current();
  if (!formatting || formatting.source !== code) {
    formatting = { source: code };
    state[SOURCE_FORMATTING_STATE] = formatting;
    void formatTypeScriptSource(code).then((formatted) => {
      const latest = current();
      if (latest?.source !== code) {
        return undefined;
      }
      latest.formatted = formatted;
      if (formatted !== code) {
        context.invalidate?.();
      }
      return undefined;
    });
  }
  return formatting.formatted ?? code;
}

function normalizedLabel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return;
  }
  const label = sanitizeTerminalText(value).replace(/\s+/g, " ").trim();
  return label || undefined;
}

function describeCall(args: ToolCallArgs, code: string, registry: FunctionRegistry): string {
  const supplied = normalizedLabel(args.label);
  if (supplied) {
    return supplied;
  }
  if (!code) return "TypeScript";
  const named = getNamedFunctionName(code);
  if (named) {
    return `${args.saveOnly === true ? "Save" : "Define and run"} ${normalizedLabel(args.functionId) ?? named}`;
  }
  const direct = resolveSavedFunctionReferences(code, registry).find(
    (reference) => reference.direct,
  );
  if (direct) {
    return `Run ${direct.name}`;
  }
  return describeCapabilityCall(inferCapabilityCall(code)) ?? "Run workspace task";
}

export function renderTypeScriptInputs(
  args: ToolCallArgs,
  theme: RenderTheme,
  context: ToolCallContext,
): string {
  ensureRendererState(context);
  const lines: string[] = [];
  const functionId = normalizedLabel(args.functionId);
  if (functionId) lines.push(theme.fg("dim", `functionId: ${functionId}`));
  if (args.saveOnly === true) lines.push("saveOnly: true");
  if (args.timeoutMs !== undefined) lines.push(`timeoutMs: ${String(args.timeoutMs)}`);
  if (Object.hasOwn(args, "params")) {
    const params = renderStructuredData(args.params, { theme }).lines;
    lines.push(theme.bold(theme.fg("toolTitle", "Params")), ...params);
  }
  const code = typeof args.code === "string" ? formattedDisplaySource(args.code, context) : "";
  if (code)
    lines.push(
      theme.bold(theme.fg("toolTitle", "Source")),
      ...highlightCode(sanitizeTerminalText(code), "typescript"),
    );
  else
    lines.push(theme.fg("dim", context.argsComplete ? "(empty source)" : "(waiting for source…)"));
  return sanitizeTerminalText(lines.join("\n"), { preserveSgr: true });
}

export function renderTypeScriptToolCall(
  args: ToolCallArgs | null | undefined,
  theme: RenderTheme,
  context: ToolCallContext,
  registry: FunctionRegistry,
) {
  args ??= {};
  ensureRendererState(context);
  const code = typeof args.code === "string" ? args.code : "";
  const callLabel = describeCall(args, code, registry);
  const generation = generationTiming(context);
  const state = generation.complete ? generation.duration : `generating... ${generation.duration}`;
  const callMarker = generation.complete ? "› " : `${generation.spinner} `;
  let text = theme.bold(
    theme.fg("accent", callMarker) +
      theme.fg("toolTitle", callLabel) +
      theme.fg("dim", ` (${state})`),
  );
  if (args.saveOnly === true) text += theme.fg("accent", " save-only");
  // Pi shares isPartial across both slots. Once settled, inputs follow the result instead.
  if (context.expanded && context.isPartial !== false)
    text += `\n${renderTypeScriptInputs(args, theme, context)}`;
  return new HangingIndentText(sanitizeTerminalText(text, { preserveSgr: true }));
}
