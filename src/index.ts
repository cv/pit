import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSavedFunctionFeatures } from "./function-lifecycle.js";
import { createFunctionState, createFunctionStateCommitQueue } from "./function-state.js";
import { SavedFunctionService } from "./saved-function-service.js";
import { registerTypeScriptTool } from "./typescript-tool.js";

export { CAPABILITY_METHODS } from "./capability-registry.js";
export { effectiveRegistry } from "./function-state.js";
export { reconstructFunctions, validateRegistryCapacity } from "./saved-functions.js";

export default function pit(pi: ExtensionAPI) {
  const functionState = createFunctionState();
  const commitFunctionState = createFunctionStateCommitQueue();
  const savedFunctionService = new SavedFunctionService({
    state: functionState,
    commit: commitFunctionState,
    appendEntry: (type, entry) => pi.appendEntry(type, entry),
  });
  registerSavedFunctionFeatures(pi, functionState, savedFunctionService);
  registerTypeScriptTool({ pi, functionState, commitFunctionState, savedFunctionService });
}
