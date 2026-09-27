import { defineNativeFunction } from "../global-definition.js";

export const modelsFunctions = [
  defineNativeFunction("models", "current", {
    summary: "Inspect current model",
    declaration: "current(): Promise<PitModelMetadata | undefined>;",
    documentation: "models.current() returns bounded metadata for the active model",
    minimumArguments: 0,
    maximumArguments: 0,
  }),
  defineNativeFunction("models", "list", {
    summary: "List configured models",
    declaration: `list(options?: { availableOnly?: boolean; query?: string; limit?: number }): Promise<{
  models: PitModelMetadata[];
  truncated: boolean;
  refreshErrors: Array<{ provider: string; message: string }>;
  refreshErrorsTruncated: boolean;
}>;`,
    documentation:
      "models.list(options?) returns bounded configured model metadata and refresh diagnostics",
    minimumArguments: 0,
    maximumArguments: 1,
  }),
  defineNativeFunction("models", "set", {
    summary: "Select a model",
    declaration:
      "set(provider: string, id: string): Promise<{ provider: string; id: string; changed: boolean }>;",
    documentation: "models.set(provider, id) selects an explicit configured model",
    minimumArguments: 2,
    maximumArguments: 2,
  }),
] as const;
