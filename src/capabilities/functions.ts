import { defineCapability } from "../capability-core.js";

export const functionsCapability = defineCapability({
  interfaceName: "PitFunctionsCapability",
  promptSummary:
    "project list/get/remove; global list/get/remove; effective listAll/getSaved/planRemoval/promote/removeSession",
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
    listGlobal: {
      callDescription: "List global functions",
      declaration: "listGlobal(): Promise<PitProjectFunctionMetadata[]>;",
      documentation: "functions.listGlobal() lists user-global functions",
      minimumArguments: 0,
      maximumArguments: 0,
    },
    getGlobal: {
      callDescription: "Inspect a global function",
      declaration:
        "getGlobal(name: string): Promise<PitProjectFunctionMetadata & { source: string }>;",
      documentation: "functions.getGlobal(name) returns global function metadata and source",
      minimumArguments: 1,
      maximumArguments: 1,
    },
    removeGlobal: {
      callDescription: "Remove a global function",
      declaration: "removeGlobal(name: string): Promise<{ name: string; removed: boolean }>;",
      documentation: "functions.removeGlobal(name) removes a confirmed user-global function",
      minimumArguments: 1,
      maximumArguments: 1,
    },
    listAll: {
      callDescription: "List all saved functions",
      declaration: "listAll(): Promise<PitSavedFunctionMetadata[]>;",
      documentation:
        "functions.listAll() lists effective functions with scope, dependencies, dependents, and override state",
      minimumArguments: 0,
      maximumArguments: 0,
    },
    getSaved: {
      callDescription: "Inspect a saved function",
      declaration: `getSaved(
  name: string,
  scope?: PitFunctionScope,
): Promise<PitSavedFunctionMetadata & { source: string }>;`,
      documentation:
        "functions.getSaved(name, scope?) returns effective or explicitly scoped saved source and dependency metadata",
      minimumArguments: 1,
      maximumArguments: 2,
    },
    planRemoval: {
      callDescription: "Plan saved function removal",
      declaration:
        "planRemoval(name: string, scope?: PitFunctionScope): Promise<PitSavedFunctionRemovalPlan>;",
      documentation:
        "functions.planRemoval(name, scope?) returns the exact closure and blockers without mutation",
      minimumArguments: 1,
      maximumArguments: 2,
    },
    promote: {
      callDescription: "Persist a session function",
      declaration: `promote(
  name: string,
  summary: string,
  options?: PitPromotionOptions,
): Promise<{ name: string; promoted: true; scope: "global" | "project" }>;`,
      documentation:
        "functions.promote(name, summary, { to? }) persists a session function to the project by default or globally after confirmation",
      minimumArguments: 2,
      maximumArguments: 3,
    },
    removeSession: {
      callDescription: "Remove a session function",
      declaration:
        "removeSession(name: string, options?: PitRemoveOptions): Promise<PitRemoveResult>;",
      documentation:
        "functions.removeSession(name, { cascade: true }) explicitly removes a function and its dependents",
      minimumArguments: 1,
      maximumArguments: 2,
    },
  },
});
