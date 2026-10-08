import type {
  ExtensionAPI,
  ToolLoadout,
  ToolLoadoutChanges,
} from "@earendil-works/pi-coding-agent";

import { createPiToolCatalog, type PiToolCatalog, piToolPrompt } from "./pi-tools.js";

export const PIT_TOOL_NAME = "typescript";

/** Tool selection resolved from a trusted project's `.pi/pit.json` at session start. */
export interface PitToolSelection {
  /** Tools declared to the model alongside `typescript` (`allowedTools`). */
  allowedTools: RegExp[];
}

export function createPitToolSelection(): PitToolSelection {
  return { allowedTools: [] };
}

/** Whole-name, case-sensitive patterns in which `*` matches any sequence. */
export function compileToolPatterns(patterns: readonly string[]): RegExp[] {
  return patterns.map(
    (pattern) =>
      new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`),
  );
}

function isAllowed(selection: PitToolSelection, name: string): boolean {
  return selection.allowedTools.some((pattern) => pattern.test(name));
}

/**
 * Adds `typescript` and the registered `allowedTools` matches to the active tools. Tools other
 * extensions activated stay active, so MCP tools and orchestrators such as `codemode` remain
 * callable; {@link pitLoadout} hides their declarations instead.
 */
export function activatePitTools(pi: ExtensionAPI, selection: PitToolSelection): void {
  const exceptions = selection.allowedTools.length
    ? pi
        .getAllTools()
        .map(({ name }) => name)
        .filter((name) => isAllowed(selection, name))
    : [];
  pi.setActiveTools([...new Set([PIT_TOOL_NAME, ...pi.getActiveTools(), ...exceptions])]);
}

/**
 * Hides the declarations of tools the model would otherwise see beside `typescript`. They stay
 * active and callable. Declared: `typescript`, `allowedTools` matches, MCP tools configured with
 * `direct` exposure, and tools that are declared only because a tool such as `tool_search`
 * loaded them (`codemode` or `deferred` exposure). `typescript`'s description lists the callable
 * tools a program can inject from `tools`; Pi passes the original description every time.
 */
export function pitLoadout(
  loadout: ToolLoadout,
  selection: PitToolSelection,
  catalog: PiToolCatalog = createPiToolCatalog(loadout.callable),
): ToolLoadoutChanges {
  const own = loadout.declared.find(({ name }) => name === PIT_TOOL_NAME);
  const prompt = piToolPrompt(catalog);
  return {
    ...(own && prompt ? { descriptions: { [PIT_TOOL_NAME]: own.description + prompt } } : {}),
    hiddenDeclarations: loadout.declared
      .map(({ name }) => name)
      .filter(
        (name) =>
          name !== PIT_TOOL_NAME && !isAllowed(selection, name) && hiddenByDefault(loadout, name),
      ),
  };
}

function hiddenByDefault(loadout: ToolLoadout, name: string): boolean {
  switch (loadout.getExposure(name)) {
    case "model-only":
      return true;
    case "direct":
      // MCP's default exposure is `codemode`, so a `direct` MCP tool is an explicit user choice.
      return !loadout.getNamespace(name)?.name.startsWith("mcp__");
    default:
      return false;
  }
}
