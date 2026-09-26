import { defineNativeFunction } from "../native-definition.js";

export const commandsFunctions = [
  defineNativeFunction("commands", "list", {
    summary: "List slash commands",
    declaration: "list(): Promise<{ commands: PitSlashCommand[]; truncated: boolean }>;",
    documentation:
      "commands.list() returns bounded extension, prompt-template, and skill commands with provenance",
    minimumArguments: 0,
    maximumArguments: 0,
  }),
] as const;
