import { defineNativeFunction } from "../global-definition.js";

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
  defineNativeFunction("session", "outline", {
    summary: "Outline model-visible context",
    declaration: `outline(options?: {
  after?: string;
  limit?: number;
  roles?: PitContextRole[];
  tool?: string;
  previewChars?: number;
}): Promise<PitContextOutline>;`,
    documentation:
      "session.outline(options?) pages model-visible active-branch entries with tokens, re-prefill cost, edit state, and protection",
    minimumArguments: 0,
    maximumArguments: 1,
  }),
  defineNativeFunction("session", "inspectEntry", {
    summary: "Read an entry's original content",
    declaration:
      "inspectEntry(id: string, options?: { offset?: number; limit?: number }): Promise<PitContextEntry>;",
    documentation:
      "session.inspectEntry(id, options?) pages an active-branch entry's original content, including elided, summarized, and compacted entries",
    minimumArguments: 1,
    maximumArguments: 2,
  }),
  defineNativeFunction("session", "elide", {
    summary: "Elide tool results from context",
    declaration:
      "elide(ids: string[], options?: { reason?: string }): Promise<PitContextEditReceipt>;",
    documentation:
      "session.elide(ids, options?) stages replacing tool results with stubs that point to session.inspectEntry; applied after the current turn if the call succeeds",
    minimumArguments: 1,
    maximumArguments: 2,
  }),
  defineNativeFunction("session", "restore", {
    summary: "Restore edited context entries",
    declaration:
      "restore(ids: string[]): Promise<PitContextEditReceipt & { restoredChars: number }>;",
    documentation:
      "session.restore(ids) stages restoring entries Pit elided or summarized; a summarized range restores as a unit",
    minimumArguments: 1,
    maximumArguments: 1,
  }),
] as const;
