import { defineCapability } from "../capability-core.js";

export const toolsCapability = defineCapability({
  interfaceName: "PitToolsCapability",
  promptSummary: "Pi tools",
  methods: {
    list: {
      callDescription: "List Pi tools by explicit visibility scope",
      declaration: `list(options?: {
  scope?: "active" | "registered";
  query?: string;
  limit?: number;
}): Promise<{ tools: PitToolMetadata[]; truncated: boolean }>;`,
      documentation:
        'tools.list(options?) returns bounded Pi tool metadata; scope defaults to "active" and "registered" explicitly includes inactive tools',
      minimumArguments: 0,
      maximumArguments: 1,
    },
    call: {
      callDescription: "Execute a Pi tool through the experimental tool API",
      declaration: `call(
  name: string,
  args: { [key: string]: PitJsonValue | undefined },
  options?: { scope?: "active" | "registered" },
): Promise<PitToolCallResult>;`,
      documentation:
        'tools.call(name, args, options?) executes through Pi-compatible validation and hooks; scope defaults to "active", so use { scope: "registered" } intentionally for inactive tools',
      minimumArguments: 2,
      maximumArguments: 3,
    },
  },
});
