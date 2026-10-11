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
  defineNativeFunction("models", "listOfType", {
    summary: "List classifier or image models",
    declaration: `listOfType(
  type: PitModelType,
  options?: { provider?: string; availableOnly?: boolean; query?: string; limit?: number },
): Promise<{ models: PitTypedModelMetadata[]; truncated: boolean }>;`,
    documentation:
      "models.listOfType(type, options?) lists classifier or image models, those with working credentials by default",
    minimumArguments: 1,
    maximumArguments: 2,
  }),
  defineNativeFunction("models", "classify", {
    summary: "Classify state with a classifier model",
    declaration: `classify(
  model: { provider: string; id: string },
  request: {
    state: Record<string, PitJsonValue>;
    questions: Record<string, PitClassifierQuestion>;
    images?: string[];
    temperature?: number;
  },
): Promise<PitModelOutcome & { answers: Record<string, PitClassifierAnswer> }>;`,
    documentation:
      "models.classify(model, request) answers typed questions about JSON state and image files; check stopReason",
    minimumArguments: 2,
    maximumArguments: 2,
  }),
  defineNativeFunction("models", "generateImages", {
    summary: "Generate images with an image model",
    declaration: `generateImages(
  model: { provider: string; id: string },
  request: { prompt: string; images?: string[]; outputDir?: string },
): Promise<
  PitModelOutcome & { images: Array<{ file: string; mimeType: string; bytes: number }>; text: string[] }
>;`,
    documentation:
      "models.generateImages(model, request) writes generated images to files and returns their paths; check stopReason",
    minimumArguments: 2,
    maximumArguments: 2,
  }),
] as const;
