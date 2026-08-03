import { defineCapability } from "../capability-core.js";

export const toolsCapability = defineCapability({
  interfaceName: "PitToolsCapability",
  promptSummary: "Pi tools",
  methods: {
    list: {
      callDescription: "List configured Pi tools",
      declaration: `list(options?: {
  activeOnly?: boolean;
  query?: string;
  limit?: number;
}): Promise<{ tools: PitToolMetadata[]; truncated: boolean }>;`,
      documentation:
        "tools.list(options?) returns bounded configured Pi tool metadata, schemas, provenance, and active state",
      minimumArguments: 0,
      maximumArguments: 1,
    },
    call: {
      callDescription: "Call a configured Pi tool",
      declaration:
        "call(name: string, args: { [key: string]: PitJsonValue | undefined }): Promise<PitToolCallResult>;",
      documentation:
        "tools.call(name, args) executes a configured Pi tool through Pi-compatible validation and lifecycle hooks",
      minimumArguments: 2,
      maximumArguments: 2,
    },
  },
});
