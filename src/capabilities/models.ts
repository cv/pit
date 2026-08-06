import { defineCapability } from "./core.js";

export const modelsCapability = defineCapability({
  interfaceName: "PitModelsCapability",
  promptSummary: "current/list/set",
  methods: {
    current: {
      callDescription: "Inspect current model",
      declaration: "current(): Promise<PitModelMetadata | undefined>;",
      documentation: "models.current() returns bounded metadata for the active model",
      minimumArguments: 0,
      maximumArguments: 0,
    },
    list: {
      callDescription: "List configured models",
      declaration: `list(options?: {
  availableOnly?: boolean;
  query?: string;
  limit?: number;
}): Promise<{ models: PitModelMetadata[]; truncated: boolean }>;`,
      documentation: "models.list(options?) returns bounded configured model metadata",
      minimumArguments: 0,
      maximumArguments: 1,
    },
    set: {
      callDescription: "Select a model",
      declaration:
        "set(provider: string, id: string): Promise<{ provider: string; id: string; changed: boolean }>;",
      documentation: "models.set(provider, id) selects an explicit configured model",
      minimumArguments: 2,
      maximumArguments: 2,
    },
  },
});
