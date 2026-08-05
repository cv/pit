import { defineCapability } from "../capability-core.js";

export const contextCapability = defineCapability({
  interfaceName: "PitContextCapability",
  methods: {
    get: {
      callDescription: "Inspect session context",
      declaration: `get(): Promise<{
  cwd: string;
  mode: string;
  model: string | undefined;
  thinkingLevel: string;
  sessionFile: string | undefined;
  savedFunctions: string[];
  globalFunctions: string[];
  projectFunctions: string[];
  sessionFunctions: string[];
  globalFunctionsEnabled: boolean;
  projectFunctionsEnabled: boolean;
}>;`,
      documentation:
        "context.get() -> cwd, mode, model, thinkingLevel, sessionFile, savedFunctions, globalFunctions, projectFunctions, sessionFunctions, globalFunctionsEnabled, projectFunctionsEnabled",
      minimumArguments: 0,
      maximumArguments: 0,
    },
  },
});
