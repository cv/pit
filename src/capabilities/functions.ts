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
    listAll: {
      callDescription: "List all saved functions",
      declaration: "listAll(): Promise<PitSavedFunctionMetadata[]>;",
      documentation: "functions.listAll",
      minimumArguments: 0,
      maximumArguments: 0,
    },
    getSaved: {
      callDescription: "Inspect a saved function",
      declaration:
        "getSaved(name: string): Promise<PitSavedFunctionMetadata & { source: string }>;",
      documentation: "functions.getSaved",
      minimumArguments: 1,
      maximumArguments: 1,
    },
    promote: {
      callDescription: "Save a session function to the project",
      declaration:
        "promote(name: string, summary: string): Promise<{ name: string; promoted: true }>;",
      documentation: "functions.promote",
      minimumArguments: 2,
      maximumArguments: 2,
    },
    removeSession: {
      callDescription: "Remove a session function",
      declaration: "removeSession(name: string): Promise<{ name: string; removed: string[] }>;",
      documentation: "functions.removeSession",
      minimumArguments: 1,
      maximumArguments: 1,
    },
  },
});
