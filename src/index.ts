import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerSavedFunctionFeatures } from "./functions/lifecycle.js";
import { SavedFunctionService } from "./functions/service.js";
import { createFunctionState, createFunctionStateCommitQueue } from "./functions/state.js";
import { createPitToolSelection } from "./functions/tool-loadout.js";
import { configuredFunctionExecutor } from "./sandbox/wasmtime-loader.js";
import { registerTypeScriptTool } from "./tool/typescript.js";

export { GLOBAL_METHODS } from "./functions/globals.js";

export default function pit(pi: ExtensionAPI) {
  const functionState = createFunctionState();
  const commitFunctionState = createFunctionStateCommitQueue();
  const toolSelection = createPitToolSelection();
  const savedFunctionService = new SavedFunctionService({
    state: functionState,
    commit: commitFunctionState,
    appendEntry: (type, entry) => pi.appendEntry(type, entry),
  });
  registerSavedFunctionFeatures(pi, functionState, savedFunctionService, toolSelection);
  const functionExecutor = configuredFunctionExecutor();
  registerTypeScriptTool({
    pi,
    functionState,
    commitFunctionState,
    savedFunctionService,
    functionExecutor,
    toolSelection,
  });
}
