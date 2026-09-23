import { highlightCode } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { FunctionRegistry } from "../functions/core.js";
import { resolveSavedFunctionReferences } from "../functions/graph.js";
import { getNamedFunctionName } from "../functions/source.js";
import { sanitizeTerminalText } from "../shared/text-sanitization.js";
import { formatTypeScriptSource } from "../tool/source-formatter.js";
import { generationTiming, type ToolCallTimingContext } from "../tool/timing.js";
import { describeCapabilityCall, inferCapabilityCall } from "./capability.js";
import { renderStructuredData } from "./compound.js";

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

type RendererState = Record<PropertyKey, unknown> & {
  [SOURCE_FORMATTING_STATE]?: SourceFormattingState;
};

function formattedDisplaySource(code: string, context: ToolCallContext): string {
  if (!(code && context.argsComplete)) {
    return code;
  }
  const root =
    context.state && typeof context.state === "object"
      ? (context.state as RendererState)
      : ({} as RendererState);
  context.state = root;
  let formatting = root[SOURCE_FORMATTING_STATE];
  if (!formatting || formatting.source !== code) {
    formatting = { source: code };
    root[SOURCE_FORMATTING_STATE] = formatting;
    void formatTypeScriptSource(code).then((formatted) => {
      if (root[SOURCE_FORMATTING_STATE]?.source !== code) {
        return undefined;
      }
      root[SOURCE_FORMATTING_STATE].formatted = formatted;
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
  const lines: string[] = [];
  const functionId = normalizedLabel(args.functionId);
  if (functionId) lines.push(theme.fg("dim", `functionId: ${functionId}`));
  if (args.saveOnly === true) lines.push("saveOnly: true");
  if (args.timeoutMs !== undefined) lines.push(`timeoutMs: ${String(args.timeoutMs)}`);
  if (Object.hasOwn(args, "params")) {
    const params = renderStructuredData(args.params, {
      theme,
      depth: 0,
      seen: new WeakSet(),
    }).lines;
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
  args: ToolCallArgs,
  theme: RenderTheme,
  context: ToolCallContext,
  registry: FunctionRegistry,
) {
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
  return new Text(sanitizeTerminalText(text, { preserveSgr: true }), 0, 0);
}
