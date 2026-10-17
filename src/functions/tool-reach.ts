import { getFunctionDependencies } from "./dependencies.js";
import { PI_TOOLS_NAMESPACE, TOOL_INDEX_NAMESPACE } from "./pi-tools.js";

/**
 * The Pi tools a `typescript` program may call, for Pi's `ToolDefinition.reachesTools`:
 * the `tools` members it and the saved functions it injects declare, or `"all"` when one of them
 * injects `toolIndex`, which finds tools at run time, or the whole `tools` namespace. Pi's MCP
 * extension waits for the servers these names belong to before the call runs, so a program that
 * starts while a server is still connecting gets its tools.
 *
 * A saved function is looked up in every layer, so a `$next` override also reaches the tools of
 * the definition it overrides. Sources that do not parse reach nothing; validation reports them.
 */
export function piToolReach(
  code: unknown,
  layers: readonly ReadonlyMap<string, string>[],
): "all" | string[] {
  if (typeof code !== "string") return [];
  const reached = new Set<string>();
  const visited = new Set<string>();
  const pending = [code];
  for (let source = pending.pop(); source !== undefined; source = pending.pop()) {
    let ids: string[];
    try {
      ids = getFunctionDependencies(source).dependencies.map(({ id }) => id);
    } catch {
      continue;
    }
    for (const id of ids) {
      const [namespace, method] = id.split(".");
      if (namespace === TOOL_INDEX_NAMESPACE) return "all";
      if (namespace === PI_TOOLS_NAMESPACE) {
        if (method === undefined) return "all";
        reached.add(method);
      } else if (!visited.has(id)) {
        visited.add(id);
        for (const layer of layers) {
          const saved = layer.get(id);
          if (saved !== undefined) pending.push(saved);
        }
      }
    }
  }
  return [...reached];
}
