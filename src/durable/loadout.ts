import type { ToolRegistration, Wrap } from "@earendil-works/pi-durable";

import { loadPitAllowedToolsSync } from "../functions/storage/project.js";
import { compileToolPatterns } from "../functions/tool-loadout.js";
import type { PitDurableLog } from "./host.js";
import { ORCHESTRATORS } from "./tools.js";

/** pi-durable's coding tools, which Pit's `workspace` and `shell` globals supersede. */
const CODING_TOOL_NAMES: readonly string[] = ["read", "write", "edit", "bash", "powershell"];

export interface PitDurableLoadoutInput {
  hideTools: boolean | readonly string[] | undefined;
  agentDir: string;
  cwd: string | undefined;
  trustProject: boolean;
  log: PitDurableLog | undefined;
}

/**
 * The tools to stop offering to the model: the hide list without `typescript`, other
 * orchestrators, and `allowedTools` matches from the user's and a trusted project's `pit.json`.
 * Resolved once, because pi-durable wrappers are fixed when the extension is built.
 */
export function resolveHiddenTools(input: PitDurableLoadoutInput): string[] {
  const requested =
    input.hideTools === false
      ? []
      : input.hideTools === true || input.hideTools === undefined
        ? CODING_TOOL_NAMES
        : input.hideTools;
  const candidates = [...new Set(requested)].filter((name) => !ORCHESTRATORS.has(name));
  if (candidates.length === 0) return [];
  if (input.trustProject && input.cwd === undefined) {
    input.log?.warning(
      "Pit read only the user's pit.json for allowedTools: the project's needs the cwd option when the extension is created",
    );
  }
  const config = loadPitAllowedToolsSync(input);
  if (config.error) input.log?.warning(config.error);
  const allowed = compileToolPatterns(config.allowedTools ?? []);
  return candidates.filter((name) => !allowed.some((pattern) => pattern.test(name)));
}

/**
 * Stops offering a tool to the model while other tools may still call it. Tools only the model may
 * call would become uncallable, and deferred tools could no longer be loaded, so both stay as
 * they are.
 */
export function hideFromModel(name: string): Wrap {
  return {
    tool: name,
    wrap: (tool: ToolRegistration) => {
      if (tool.deferred === true) return tool;
      const callers = tool.callers ?? ["model", "tools"];
      if (!callers.includes("model") || !callers.includes("tools")) return tool;
      return { ...tool, callers: callers.filter((caller) => caller !== "model") };
    },
  };
}
