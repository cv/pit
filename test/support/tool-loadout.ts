import type { ToolExposure, ToolLoadout } from "@earendil-works/pi-coding-agent";

/** One tool in a test loadout: its declaration fields, plus how Pi exposes it. */
export interface LoadoutTool {
  name: string;
  /** How Pi exposes the tool; defaults to direct. */
  exposure?: ToolExposure;
  /** The namespace Pi groups the tool under, such as an MCP server. */
  namespace?: string;
  [field: string]: unknown;
}

/**
 * A session's tools as Pi hands them to prepareLoadout(). Tests build every loadout here, so a Pi
 * release that adds a ToolLoadout member, as Pi 1.1 did with getPromptGuidelines, needs one change.
 *
 * @param tools - The declared and registered tools.
 * @param options.callable - The tools Pi can call now; defaults to every declared tool.
 */
export function toolLoadout(
  tools: LoadoutTool[],
  options: { callable?: LoadoutTool[] } = {},
): ToolLoadout {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  // Exposure and namespace come from the loadout's accessors, not the tool declarations.
  const declarations = (entries: LoadoutTool[]) =>
    entries.map(({ exposure: _exposure, namespace: _namespace, ...tool }) => tool);
  const declared = declarations(tools) as unknown as ToolLoadout["declared"];
  return {
    declared,
    callable: declarations(options.callable ?? tools) as unknown as ToolLoadout["callable"],
    registered: declared,
    // These fixtures declare no promptGuidelines.
    getPromptGuidelines: () => [],
    getExposure: (name) => byName.get(name)?.exposure ?? "direct",
    getNamespace: (name) => {
      const namespace = byName.get(name)?.namespace;
      return namespace ? { name: namespace } : undefined;
    },
  };
}
