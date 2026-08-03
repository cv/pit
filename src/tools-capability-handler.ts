import {
  boundedIntegerValue as boundedInteger,
  recordValue as object,
  stringValue as string,
} from "./cli.js";
import type { PiToolBridge } from "./pi-tool-bridge.js";

const MAX_TOOLS = 200;

type ToolsCapabilityHandler = (
  method: string,
  args: unknown[],
  signal: AbortSignal,
) => unknown | Promise<unknown>;

export function createToolsCapabilityHandler(bridge: PiToolBridge): ToolsCapabilityHandler {
  return async (method, args, signal) => {
    if (method === "list") {
      const options = args[0] === undefined ? {} : object(args[0], "options");
      const activeOnly = options.activeOnly ?? false;
      if (typeof activeOnly !== "boolean") {
        throw new Error("options.activeOnly must be a boolean");
      }
      const query =
        options.query === undefined ? "" : string(options.query, "options.query").toLowerCase();
      const limit = boundedInteger(options.limit, "options.limit", MAX_TOOLS, 100);
      const matches = bridge
        .list()
        .filter((tool) => !activeOnly || tool.active)
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
    return await bridge.call(name, object(args[1], "tool arguments"), signal);
  };
}
