import { defineNativeFunction } from "../native-definition.js";

export const functionsFunctions = [
  defineNativeFunction("functions", "list", {
    summary: "List project functions",
    declaration: "list(): Promise<PitPersistentFunctionMetadata[]>;",
    documentation: "functions.list() lists trusted project-persisted functions",
    minimumArguments: 0,
    maximumArguments: 0,
  }),
  defineNativeFunction("functions", "get", {
    summary: "Inspect a project function",
    declaration: "get(name: string): Promise<PitPersistentFunctionMetadata & { source: string }>;",
    documentation: "functions.get(name) returns project function metadata and source",
    minimumArguments: 1,
    maximumArguments: 1,
  }),
  defineNativeFunction("functions", "remove", {
    summary: "Remove a project function",
    declaration: "remove(name: string): Promise<{ name: string; removed: boolean }>;",
    documentation: "functions.remove(name) removes a trusted project-persisted function",
    minimumArguments: 1,
    maximumArguments: 1,
  }),
  defineNativeFunction("functions", "listUser", {
    summary: "List user functions",
    declaration: "listUser(): Promise<PitPersistentFunctionMetadata[]>;",
    documentation: "functions.listUser() lists user functions",
    minimumArguments: 0,
    maximumArguments: 0,
  }),
  defineNativeFunction("functions", "getUser", {
    summary: "Inspect a user function",
    declaration:
      "getUser(name: string): Promise<PitPersistentFunctionMetadata & { source: string }>;",
    documentation: "functions.getUser(name) returns user function metadata and source",
    minimumArguments: 1,
    maximumArguments: 1,
  }),
  defineNativeFunction("functions", "removeUser", {
    summary: "Remove a user function",
    declaration: "removeUser(name: string): Promise<{ name: string; removed: boolean }>;",
    documentation: "functions.removeUser(name) removes a confirmed user function",
    minimumArguments: 1,
    maximumArguments: 1,
  }),
  defineNativeFunction("functions", "listAll", {
    summary: "List function definitions",
    declaration: "listAll(options?: PitFunctionListOptions): Promise<PitFunctionListResult>;",
    documentation:
      "functions.listAll({ scope?, allDefinitions?, offset?, limit? }?) -> { functions, total, offset, nextOffset? }",
    minimumArguments: 0,
    maximumArguments: 1,
  }),
  defineNativeFunction("functions", "getSaved", {
    summary: "Inspect a function definition",
    declaration:
      "getSaved(name: string, scope?: PitFunctionScope): Promise<PitFunctionInspection>;",
    documentation:
      "functions.getSaved(name, scope?) inspects source/native metadata, chains, next, and effects",
    minimumArguments: 1,
    maximumArguments: 2,
  }),
  defineNativeFunction("functions", "planRemoval", {
    summary: "Plan saved function removal",
    declaration:
      "planRemoval(name: string, scope?: PitFunctionScope): Promise<PitSavedFunctionRemovalPlan>;",
    documentation:
      "functions.planRemoval(name, scope?) returns the exact closure and blockers without mutation",
    minimumArguments: 1,
    maximumArguments: 2,
  }),
  defineNativeFunction("functions", "promote", {
    summary: "Persist a session function",
    declaration: `promote(
  name: string,
  summary: string,
  options?: PitPromotionOptions,
): Promise<{ name: string; promoted: true; scope: "user" | "project" }>;`,
    documentation:
      "functions.promote(name, summary, { to? }) persists a session function to the project by default or to user scope after confirmation",
    minimumArguments: 2,
    maximumArguments: 3,
  }),
  defineNativeFunction("functions", "removeSession", {
    summary: "Remove a session function",
    declaration:
      "removeSession(name: string, options?: PitRemoveOptions): Promise<PitRemoveResult>;",
    documentation:
      "functions.removeSession(name, { cascade: true }) explicitly removes a function and its dependents",
    minimumArguments: 1,
    maximumArguments: 2,
  }),
] as const;
