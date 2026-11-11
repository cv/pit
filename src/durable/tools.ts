import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";

import {
  createPiToolCatalog,
  describePiTool,
  type PiToolCatalog,
  searchPiTools,
  TOOL_INDEX_NAMESPACE,
} from "../functions/pi-tools.js";
import type { HostToolCall } from "../host/native-dispatcher.js";
import { stringValue as string } from "../shared/argument-values.js";
import { isRecord } from "../shared/records.js";
import type { ImageBlock, ImageCollector } from "../workspace/view-image.js";

type ToolContext = Parameters<ToolRegistration["execute"]>[2];

/** The host tools a call may run through `tools.*`: the agent's tools other callers may use. */
export function createDurableToolCatalog(callable: readonly ToolRegistration[]): PiToolCatalog {
  return createPiToolCatalog(
    callable.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.structuredOutputSchema === undefined
        ? {}
        : { outputSchema: tool.structuredOutputSchema }),
    })),
  );
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  const blocks = Array.isArray(value) ? value : [value];
  return blocks
    .flatMap((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n");
}

function imagesOf(value: unknown): ImageBlock[] {
  const blocks = Array.isArray(value) ? value : [value];
  return blocks.flatMap((block) =>
    isRecord(block) &&
    block.type === "image" &&
    typeof block.data === "string" &&
    typeof block.mimeType === "string"
      ? [{ type: "image" as const, data: block.data, mimeType: block.mimeType }]
      : [],
  );
}

export interface DurableToolCallServices {
  api: Pick<ToolExecutionApi, "executeTool">;
  context: ToolContext;
  catalog: PiToolCatalog;
  images: ImageCollector;
}

/**
 * Runs one `tools.*` or `toolIndex.*` call. Tool calls go through `executeTool()`, so the host's
 * argument validation and tool hooks apply as for model calls, and the Harness validates a
 * declared structured output.
 */
export async function callDurableTool(
  services: DurableToolCallServices,
  { namespace, method, args }: HostToolCall,
): Promise<unknown> {
  const { catalog } = services;
  if (namespace === TOOL_INDEX_NAMESPACE) {
    if (method === "search") {
      const limit = typeof args[1] === "number" ? args[1] : undefined;
      return searchPiTools(catalog, string(args[0], "query"), limit);
    }
    return describePiTool(catalog, string(args[0], "name"));
  }
  const entry = catalog.bindings.get(method);
  /* v8 ignore next -- validation binds only the catalog's tools. */
  if (!entry) throw new Error(`Unknown host function: ${namespace}.${method}`);
  if (args.length > 1) {
    throw new Error(`${namespace}.${method} expects 0-1 argument(s); received ${args.length}`);
  }
  const input = args[0] ?? {};
  if (!isRecord(input)) throw new Error(`${namespace}.${method} expects an arguments object`);
  const result = await services.api.executeTool(
    entry.toolName,
    input as Parameters<ToolExecutionApi["executeTool"]>[1],
    services.context,
  );
  if (result.isError) {
    const text =
      textOf(result.structuredOutput) ||
      result.diagnostics
        .filter((diagnostic) => diagnostic.severity === "error")
        .map((diagnostic) => diagnostic.message)
        .join("; ");
    throw new Error(text ? `${entry.toolName} failed: ${text}` : `${entry.toolName} failed`);
  }
  if (entry.outputSchema) {
    /* v8 ignore next 3 -- the Harness rejects a declared schema's missing structured output. */
    if (result.structuredOutput === undefined) {
      throw new Error(`${entry.toolName} returned no structured result despite declaring one`);
    }
    return result.structuredOutput;
  }
  for (const image of imagesOf(result.structuredOutput)) {
    services.images.attachBlock(image, entry.toolName);
  }
  return textOf(result.structuredOutput);
}
