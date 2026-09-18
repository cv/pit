import { defineCapability } from "./core.js";

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
  userFunctions: string[];
  projectFunctions: string[];
  sessionFunctions: string[];
  projectFunctionsEnabled: boolean;
}>;`,
      documentation:
        "context.get() -> cwd, mode, model, thinkingLevel, sessionFile, savedFunctions, globalFunctions, userFunctions, projectFunctions, sessionFunctions, projectFunctionsEnabled",
      minimumArguments: 0,
      maximumArguments: 0,
    },
  },
});
