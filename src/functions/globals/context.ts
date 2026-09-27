import { defineNativeFunction } from "../global-definition.js";

export const contextFunctions = [
  defineNativeFunction("context", "get", {
    summary: "Inspect session context",
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
  }),
] as const;
