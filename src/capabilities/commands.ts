import { defineCapability } from "./core.js";

export const commandsCapability = defineCapability({
  interfaceName: "PitCommandsCapability",
  promptSummary: "list",
  methods: {
    list: {
      callDescription: "List slash commands",
      declaration: "list(): Promise<{ commands: PitSlashCommand[]; truncated: boolean }>;",
      documentation:
        "commands.list() returns bounded extension, prompt-template, and skill commands with provenance",
      minimumArguments: 0,
      maximumArguments: 0,
    },
  },
});
