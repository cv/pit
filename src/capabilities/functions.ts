import { defineCapability } from "../capability-core.js";

export const functionsCapability = defineCapability({
  interfaceName: "PitFunctionsCapability",
  methods: {
    list: {
      callDescription: "List project functions",
      declaration: "list(): Promise<PitProjectFunctionMetadata[]>;",
      documentation: "functions.list() lists trusted project-persisted functions",
      minimumArguments: 0,
      maximumArguments: 0,
    },
    get: {
      callDescription: "Inspect a project function",
      declaration: "get(name: string): Promise<PitProjectFunctionMetadata & { source: string }>;",
      documentation: "functions.get(name) returns project function metadata and source",
      minimumArguments: 1,
      maximumArguments: 1,
    },
    remove: {
      callDescription: "Remove a project function",
      declaration: "remove(name: string): Promise<{ name: string; removed: boolean }>;",
      documentation: "functions.remove(name) removes a trusted project-persisted function",
      minimumArguments: 1,
      maximumArguments: 1,
    },
  },
});
