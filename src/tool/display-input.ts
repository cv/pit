import { validateToolArguments, type Tool, type ToolCall } from "@earendil-works/pi-ai";

import type { ToolCallArgs } from "../renderers/typescript-tool-call.js";
import { isRecord } from "../shared/records.js";
import { omitNullArguments } from "./input.js";
import { ensureRendererState } from "./renderer-state.js";
import { applySourceOptions } from "./source-options.js";

interface DisplayInputContext {
  toolCallId: string;
  argsComplete?: boolean;
  isPartial?: boolean;
  state?: unknown;
}

interface DisplayOptionsCache {
  partial: boolean;
  source: string;
  input: ToolCallArgs;
}

const DISPLAY_OPTIONS_CACHE = Symbol("pit-display-source-options");

/** Apply valid options for display; keep the original header if preparation or validation fails. */
function prepareDisplayInput(input: ToolCallArgs, tool: Tool): ToolCallArgs {
  try {
    const applied = applySourceOptions(input);
    if (applied === input) return input;
    const prepared = omitNullArguments(applied);
    if (!isRecord(prepared)) return input;
    // Pi tool arguments are JSON. Reuse its schema validator so coercions match execution.
    const validated: unknown = validateToolArguments(tool, {
      type: "toolCall",
      id: "",
      name: "typescript",
      arguments: prepared as ToolCall["arguments"],
    });
    if (isRecord(validated)) return validated;
  } catch {
    // Execution reports the error; the renderer must still show the submitted source.
  }
  return input;
}

/** Resolve the exact input a row should show, including Pi's stale streaming arguments. */
export function createDisplayInputResolver(
  parameters: Tool["parameters"],
  recoveredSources: ReadonlyMap<string, string>,
) {
  const tool: Tool = { name: "typescript", description: "", parameters };
  return (args: ToolCallArgs | null | undefined, context: DisplayInputContext): ToolCallArgs => {
    const recovered = recoveredSources.get(context.toolCallId);
    // Streaming fields are partial; a recovered source is the complete finalized call.
    const input =
      recovered !== undefined && !(args && Object.hasOwn(args, "code"))
        ? { code: recovered }
        : (args ?? {});
    if (typeof input.code !== "string") return input;
    // Pi restores settled rows without setting argsComplete; streaming rows remain partial.
    const partial = !context.argsComplete && context.isPartial !== false;
    const prepare = (): ToolCallArgs => {
      const prepared = prepareDisplayInput(input, tool);
      // A complete header can supply a label while streaming, but the submitted source is partial.
      return partial && prepared !== input ? { ...prepared, code: input.code } : prepared;
    };
    // Complete grammar calls usually have only `code`. Cache those per row, but do not cache
    // heterogeneous inputs whose other fields may change independently of the source.
    if (Object.keys(input).length !== 1) return prepare();
    ensureRendererState(context);
    const previous = context.state[DISPLAY_OPTIONS_CACHE] as DisplayOptionsCache | undefined;
    if (previous?.source === input.code && previous.partial === partial) return previous.input;
    const prepared = prepare();
    context.state[DISPLAY_OPTIONS_CACHE] = {
      source: input.code,
      partial,
      input: prepared,
    } satisfies DisplayOptionsCache;
    return prepared;
  };
}
