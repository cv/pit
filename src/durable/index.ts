import type { Extension, PromptInput } from "@earendil-works/pi-durable";

import { createCodemodeFunctionExecutor } from "../sandbox/codemode-executor.js";
import { NODE_HOST_PLATFORM } from "../shared/host-platform.js";
import { conversationCwd, type PitDurableLog, type PitDurableUi } from "./host.js";
import { createCatalogSections, GUIDELINES_SECTION } from "./sections.js";
import { DurableFunctionStore } from "./state.js";
import { createDurableTypeScriptTool } from "./tool.js";

export type { PitDurableLog, PitDurableUi } from "./host.js";
export { PitDurableUnavailableError } from "./host.js";

export interface PitDurableOptions {
  /**
   * The working directory for programs, commands, and project functions. Default: the call's
   * execution environment's `cwd`, then the agent's, then the process's.
   */
  cwd?: string;
  /**
   * The agent directory for user functions and the user-wide `pit.json`. Default:
   * `PI_CODING_AGENT_DIR`, else `~/.pi/agent`, as on Pi.
   */
  agentDir?: string;
  /**
   * Whether to trust the project: load its `.pi/pit.json` and `.pi/functions`, and let programs
   * save project functions. Default `false`; set it only for repositories whose code you would
   * run anyway.
   */
  trustProject?: boolean;
  /**
   * Dialogs for `ui.*` and for confirming user-scope changes. Default: none, as on Pi without a
   * UI: `ui.*` throws and `context.get()` reports `hasUI: false`.
   */
  ui?: PitDurableUi;
  /** Receives warnings Pi would show as notifications, such as saved functions that failed to load. */
  log?: PitDurableLog;
}

/**
 * Pit's `typescript` tool for hosts built on pi-durable: the tool, its usage guidelines, and the
 * user and project function catalogs as prompt sections. Session functions are conversation
 * entries, so they survive a reopened Harness and carry into forks.
 */
export function createPitDurableExtension(options: PitDurableOptions = {}): Extension {
  const store = new DurableFunctionStore({
    agentDir: options.agentDir ?? NODE_HOST_PLATFORM.agentDir(),
    trustProject: options.trustProject ?? false,
  });
  const cwdOf = (input: PromptInput) => conversationCwd(options.cwd, input.env, input.agent);
  return {
    name: "pit",
    tools: [
      createDurableTypeScriptTool({
        store,
        functionExecutor: createCodemodeFunctionExecutor(),
        cwd: options.cwd,
        trustProject: options.trustProject ?? false,
        ui: options.ui,
        log: options.log,
      }),
    ],
    sections: [GUIDELINES_SECTION, ...createCatalogSections(store, cwdOf)],
  };
}

/** The name hosts look up to load any package's pi-durable extension. */
export const createPiDurableExtension = createPitDurableExtension;
