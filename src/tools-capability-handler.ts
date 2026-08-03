import {
  boundedIntegerValue as boundedInteger,
  recordValue as object,
  stringValue as string,
} from "./cli.js";
import type { ToolProgressEvent } from "./execution-types.js";
import type { PiToolExecutionApi, PiToolExecutionResult, PiToolScope } from "./pi-tool-api.js";

const MAX_TOOLS = 200;

type ToolsCapabilityHandler = (
  method: string,
  args: unknown[],
  signal: AbortSignal,
) => unknown | Promise<unknown>;

function scope(value: unknown, label: string): PiToolScope {
  if (value === undefined) {
    return "active";
  }
  if (value !== "active" && value !== "registered") {
    throw new Error(`${label} must be "active" or "registered"`);
  }
  return value;
}

function jsonProjection(value: unknown, label: string): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError("value has no JSON representation");
    }
    return JSON.parse(serialized);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TypeError(`${label} is not JSON-safe: ${detail}`);
  }
}

function projectToolResult(result: PiToolExecutionResult): Record<string, unknown> {
  return {
    toolCallId: result.toolCallId,
    content: jsonProjection(result.content ?? [], "tool result content"),
    ...(result.details === undefined
      ? {}
      : { details: jsonProjection(result.details, "tool result details") }),
    ...(result.usage === undefined
      ? {}
      : { usage: jsonProjection(result.usage, "tool result usage") }),
    ...(result.addedToolNames === undefined ? {} : { addedToolNames: result.addedToolNames }),
    ...(result.terminate === undefined ? {} : { terminate: result.terminate }),
    isError: result.isError,
    ...(result.errorKind === undefined ? {} : { errorKind: result.errorKind }),
  };
}

export function createToolsCapabilityHandler(
  api: PiToolExecutionApi,
  onProgress?: (event: ToolProgressEvent) => void,
): ToolsCapabilityHandler {
  return async (method, args, signal) => {
    if (method === "list") {
      const options = args[0] === undefined ? {} : object(args[0], "options");
      const visibility = scope(options.scope, "options.scope");
      const query =
        options.query === undefined ? "" : string(options.query, "options.query").toLowerCase();
      const limit = boundedInteger(options.limit, "options.limit", MAX_TOOLS, 100);
      const matches = api
        .listTools({ scope: visibility })
        .filter((tool) =>
          `${tool.name} ${tool.description} ${tool.sourceInfo.source}`
            .toLowerCase()
            .includes(query),
        );
      return {
        tools: matches.slice(0, limit).map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          ...(tool.promptGuidelines === undefined
            ? {}
            : { promptGuidelines: tool.promptGuidelines }),
          active: tool.active,
          sourceInfo: tool.sourceInfo,
        })),
        truncated: matches.length > limit,
      };
    }

    const name = string(args[0], "tool name");
    if (name === "typescript") {
      throw new Error('The "typescript" tool cannot call itself through tools.call()');
    }
    const options = args[2] === undefined ? {} : object(args[2], "options");
    const visibility = scope(options.scope, "options.scope");
    const result = await api.executeTool(name, object(args[1], "tool arguments"), {
      scope: visibility,
      signal,
      ...(onProgress
        ? {
            onUpdate: (update, context) =>
              onProgress({ phase: "update", name, toolCallId: context.toolCallId, update }),
          }
        : {}),
    });
    let projected: Record<string, unknown>;
    try {
      projected = projectToolResult(result);
    } catch (error) {
      onProgress?.({ phase: "end", name, toolCallId: result.toolCallId, isError: true });
      throw error;
    }
    onProgress?.({ phase: "end", name, toolCallId: result.toolCallId, isError: result.isError });
    return projected;
  };
}
