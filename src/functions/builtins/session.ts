import { defineNativeFunction } from "../native-definition.js";

export const sessionFunctions = [
  defineNativeFunction("session", "info", {
    summary: "Inspect session metadata",
    declaration: `info(): Promise<{
  id: string;
  file: string | undefined;
  name: string | undefined;
  leafId: string | null;
  entryCount: number;
  branchEntryCount: number;
  contextTokens: number | null | undefined;
  contextWindow: number | undefined;
  contextPercent: number | null | undefined;
}>;`,
    documentation: "session.info() returns bounded active-session metadata and context usage",
    minimumArguments: 0,
    maximumArguments: 0,
  }),
  defineNativeFunction("session", "getName", {
    summary: "Get session name",
    declaration: "getName(): Promise<string | undefined>;",
    documentation: "session.getName() returns the current display name",
    minimumArguments: 0,
    maximumArguments: 0,
  }),
  defineNativeFunction("session", "setName", {
    summary: "Set session name",
    declaration: "setName(name: string): Promise<{ name: string }>;",
    documentation: "session.setName(name) sets the current display name",
    minimumArguments: 1,
    maximumArguments: 1,
  }),
  defineNativeFunction("session", "compact", {
    summary: "Compact session context",
    declaration: `compact(instructions?: string): Promise<{
  firstKeptEntryId: string;
  tokensBefore: number;
  estimatedTokensAfter: number | undefined;
}>;`,
    documentation:
      "session.compact(instructions?) awaits manual compaction and returns bounded metadata",
    minimumArguments: 0,
    maximumArguments: 1,
  }),
] as const;
