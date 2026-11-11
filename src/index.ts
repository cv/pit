import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  formatSize,
  getAgentDir,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

import { registerContextBoundary } from "./context/boundary.js";
import { ContextEditQueue } from "./context/queue.js";
import { registerSavedFunctionFeatures } from "./functions/lifecycle.js";
import { SavedFunctionService } from "./functions/service.js";
import { createFunctionState, createFunctionStateCommitQueue } from "./functions/state.js";
import { createPitToolSelection } from "./functions/tool-loadout.js";
import { registerContextRenderers } from "./renderers/context-entries.js";
import { createCodemodeFunctionExecutor } from "./sandbox/codemode-executor.js";
import { installHostPlatform } from "./shared/host-platform.js";
import { registerTypeScriptTool } from "./tool/typescript.js";

export { GLOBAL_METHODS } from "./functions/globals.js";

export default function pit(pi: ExtensionAPI) {
  // Pi's helpers: pit's writes queue with Pi's edit and write tools, and Pi's directories apply.
  installHostPlatform({
    agentDir: getAgentDir,
    configDirName: CONFIG_DIR_NAME,
    formatSize,
    withFileMutationQueue,
  });
  const functionState = createFunctionState();
  const commitFunctionState = createFunctionStateCommitQueue();
  const toolSelection = createPitToolSelection();
  const contextEdits = new ContextEditQueue();
  registerContextBoundary(pi, contextEdits);
  registerContextRenderers(pi);
  const savedFunctionService = new SavedFunctionService({
    state: functionState,
    commit: commitFunctionState,
    appendEntry: (type, entry) => pi.appendEntry(type, entry),
  });
  registerSavedFunctionFeatures(pi, functionState, savedFunctionService, toolSelection);
  const functionExecutor = createCodemodeFunctionExecutor();
  registerTypeScriptTool({
    pi,
    functionState,
    commitFunctionState,
    savedFunctionService,
    functionExecutor,
    toolSelection,
    contextEdits,
  });
}
