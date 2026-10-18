/**
 * Recognizes the result schema Pi's MCP extension declares for every MCP tool, so `tools.*` can
 * return the structured content an MCP `CallToolResult` wraps.
 */
import { isRecord } from "../shared/records.js";

const MCP_CONTENT_POINTER = "#/properties/structuredContent";

/**
 * Points `$ref`s that Pi moved below `#/properties/structuredContent`, when it nested an MCP tool's
 * output schema in its result schema, back at the root, so the schema resolves on its own.
 */
function unnestReferences(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(unnestReferences);
  if (!isRecord(schema)) return schema;
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => {
      if (
        key === "$ref" &&
        typeof value === "string" &&
        (value === MCP_CONTENT_POINTER || value.startsWith(`${MCP_CONTENT_POINTER}/`))
      ) {
        return [key, `#${value.slice(MCP_CONTENT_POINTER.length)}`];
      }
      return [key, unnestReferences(value)];
    }),
  );
}

/**
 * The schema of the structured content an MCP tool's `CallToolResult` wraps: `null` when the server
 * declares none, `undefined` when the tool is not an MCP tool. Pi's MCP extension declares
 * `{ content, structuredContent, isError }`, with `{}` for undeclared structured content.
 */
export function mcpContentSchema(schema: unknown): Record<string, unknown> | null | undefined {
  if (!isRecord(schema) || !isRecord(schema.properties)) return undefined;
  const { content, isError, structuredContent } = schema.properties;
  if (!isRecord(content) || content.type !== "array") return undefined;
  if (!isRecord(isError) || isError.type !== "boolean") return undefined;
  if (!isRecord(structuredContent) || Object.keys(structuredContent).length === 0) return null;
  return unnestReferences(structuredContent) as Record<string, unknown>;
}
