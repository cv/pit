import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerSavedFunctionFeatures } from "./functions/lifecycle.js";
import { SavedFunctionService } from "./functions/service.js";
import { createFunctionState, createFunctionStateCommitQueue } from "./functions/state.js";
import { registerTypeScriptTool } from "./tool/typescript.js";

export { CAPABILITY_METHODS } from "./capabilities/registry.js";
export { effectiveRegistry } from "./functions/state.js";
export { reconstructFunctions, validateRegistryCapacity } from "./functions/core.js";

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
