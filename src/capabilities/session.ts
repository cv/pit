import { defineCapability } from "../capability-core.js";

export const sessionCapability = defineCapability({
  interfaceName: "PitSessionCapability",
  promptSummary: "info/name/compact/new/fork/clone",
  methods: {
    info: {
      callDescription: "Inspect session metadata",
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
    },
    getName: {
      callDescription: "Get session name",
      declaration: "getName(): Promise<string | undefined>;",
      documentation: "session.getName() returns the current display name",
      minimumArguments: 0,
      maximumArguments: 0,
    },
    setName: {
      callDescription: "Set session name",
      declaration: "setName(name: string): Promise<{ name: string }>;",
      documentation: "session.setName(name) sets the current display name",
      minimumArguments: 1,
      maximumArguments: 1,
    },
    compact: {
      callDescription: "Compact session context",
      declaration: `compact(instructions?: string): Promise<{
  firstKeptEntryId: string;
  tokensBefore: number;
  estimatedTokensAfter: number | undefined;
}>;`,
      documentation:
        "session.compact(instructions?) awaits manual compaction and returns bounded metadata",
      minimumArguments: 0,
      maximumArguments: 1,
    },
    requestNew: {
      callDescription: "Request a new session",
      declaration: "requestNew(): Promise<{ queued: true; command: string }>;",
      documentation: "session.requestNew() queues a confirmed new-session command",
      minimumArguments: 0,
      maximumArguments: 0,
    },
    requestFork: {
      callDescription: "Request a session fork",
      declaration: "requestFork(entryId: string): Promise<{ queued: true; command: string }>;",
      documentation: "session.requestFork(entryId) queues a confirmed fork-before command",
      minimumArguments: 1,
      maximumArguments: 1,
    },
    requestClone: {
      callDescription: "Request a session clone",
      declaration: "requestClone(entryId: string): Promise<{ queued: true; command: string }>;",
      documentation: "session.requestClone(entryId) queues a confirmed clone-through command",
      minimumArguments: 1,
      maximumArguments: 1,
    },
  },
});
