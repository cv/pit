import type { AgentToolResult, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import {
  describePiTool,
  type JsonSchema,
  type PiToolBinding,
  type PiToolCatalog,
  searchPiTools,
  TOOL_INDEX_NAMESPACE,
} from "../../functions/pi-tools.js";
import { stringValue as string } from "../../shared/argument-values.js";
import { isRecord } from "../../shared/records.js";

export type ToolImageBlock = Extract<
  AgentToolResult<unknown>["content"][number],
  { type: "image" }
>;

export interface PiToolCallServices {
  ctx: Pick<ExtensionToolContext, "executeTool">;
  catalog: PiToolCatalog;
  /** A nested call returned `terminate: true`. */
  onTerminate(): void;
  /** Attaches an image a tool returned to the `typescript` result. */
  attachImage(image: ToolImageBlock, toolName: string): void;
}

const MAX_SCHEMA_ERRORS = 3;
const MAX_SCHEMA_DEPTH = 64;

function contentBlocks(content: unknown): Record<string, unknown>[] {
  /* v8 ignore next -- Pi validates tool results to carry a content array. */
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

function textOf(content: unknown): string {
  return contentBlocks(content)
    .flatMap((block) =>
      block.type === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("\n");
}

function imagesOf(content: unknown): ToolImageBlock[] {
  return contentBlocks(content).flatMap((block) =>
    block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string"
      ? [{ type: "image" as const, data: block.data, mimeType: block.mimeType }]
      : [],
  );
}

/**
 * Removes object properties a schema forbids. Real servers return fields their own output schemas
 * exclude (the reference memory server adds `type` to every entity), and those fields are absent
 * from the declared type anyway. Everything else is left for validation.
 */
function withoutUndeclaredProperties(schema: unknown, value: unknown, depth = 0): unknown {
  /* v8 ignore next -- boolean subschemas and self-referencing schemas deeper than the bound. */
  if (!isRecord(schema) || depth > MAX_SCHEMA_DEPTH) return value;
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      const cleaned = withoutUndeclaredProperties(branch, value, depth + 1);
      if (Value.Check(branch as never, cleaned)) return cleaned;
    }
    return value;
  }
  if (Array.isArray(value)) {
    const items = schema.items;
    return isRecord(items)
      ? value.map((item) => withoutUndeclaredProperties(items, item, depth + 1))
      : value;
  }
  if (!isRecord(value)) return value;
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const additional = schema.additionalProperties;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (Object.hasOwn(properties, key)) {
      result[key] = withoutUndeclaredProperties(properties[key], entry, depth + 1);
    } else if (additional !== false) {
      result[key] = withoutUndeclaredProperties(additional, entry, depth + 1);
    }
  }
  return result;
}

function conform(entry: PiToolBinding, schema: JsonSchema, value: unknown): unknown {
  const cleaned = withoutUndeclaredProperties(schema, value);
  if (Value.Check(schema as never, cleaned)) return cleaned;
  const errors = [...Value.Errors(schema as never, cleaned)]
    .slice(0, MAX_SCHEMA_ERRORS)
    .map((error) => `${error.instancePath || "/"} ${error.message}`);
  throw new Error(
    `${entry.toolName} returned a result that does not match its output schema: ${errors.join("; ")}`,
  );
}

function callToolIndex(catalog: PiToolCatalog, method: string, args: unknown[]): unknown {
  if (method === "search") {
    const limit = typeof args[1] === "number" ? args[1] : undefined;
    return searchPiTools(catalog, string(args[0], "query"), limit);
  }
  if (method === "describe") return describePiTool(catalog, string(args[0], "name"));
  /* v8 ignore next -- validation binds only search and describe. */
  throw new Error(`Unknown host function: ${TOOL_INDEX_NAMESPACE}.${method}`);
}

/**
 * Runs one `tools.*` or `toolIndex.*` call. Tool calls go through `ctx.executeTool()`, so Pi's
 * argument preparation, validation, hooks, and permission checks apply as for model calls.
 */
export async function callPiTool(
  services: PiToolCallServices,
  call: { namespace: string; method: string; args: unknown[]; signal: AbortSignal },
): Promise<unknown> {
  const { namespace, method, args, signal } = call;
  if (namespace === TOOL_INDEX_NAMESPACE) return callToolIndex(services.catalog, method, args);
  const entry = services.catalog.bindings.get(method);
  /* v8 ignore next -- validation binds only the catalog's tools. */
  if (!entry) throw new Error(`Unknown host function: ${namespace}.${method}`);
  if (args.length > 1) {
    throw new Error(`${namespace}.${method} expects 0-1 argument(s); received ${args.length}`);
  }
  const input = args[0] ?? {};
  if (!isRecord(input)) throw new Error(`${namespace}.${method} expects an arguments object`);
  const outcome = await services.ctx.executeTool(entry.toolName, input, { signal });
  const result = outcome.result;
  if (result.terminate === true) services.onTerminate();
  // Pi's MCP extension returns the server's untruncated CallToolResult as structuredContent.
  const payload =
    entry.mcp && isRecord(result.structuredContent) ? result.structuredContent : undefined;
  const content = payload?.content ?? result.content;
  const text = textOf(content);
  if (outcome.isError || payload?.isError === true) {
    throw new Error(text ? `${entry.toolName} failed: ${text}` : `${entry.toolName} failed`);
  }
  for (const image of imagesOf(content)) services.attachImage(image, entry.toolName);
  if (!entry.outputSchema) return text;
  const structured = entry.mcp ? payload?.structuredContent : result.structuredContent;
  if (structured === undefined) {
    throw new Error(`${entry.toolName} returned no structured result despite declaring one`);
  }
  return conform(entry, entry.outputSchema, structured);
}
