import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerSavedFunctionFeatures } from "./functions/lifecycle.js";
import { SavedFunctionService } from "./functions/service.js";
import { createFunctionState, createFunctionStateCommitQueue } from "./functions/state.js";
import { configuredFunctionExecutor } from "./sandbox/wasmtime-loader.js";
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
  const functionExecutor = configuredFunctionExecutor();
  registerTypeScriptTool({
    pi,
    functionState,
    commitFunctionState,
    savedFunctionService,
    /* v8 ignore next -- opt-in native branch is exercised by the Docker Pi smoke target. */
    ...(functionExecutor ? { functionExecutor } : {}),
  });
}
