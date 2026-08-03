import { defineCapability } from "../capability-core.js";

export const runtimeCapability = defineCapability({
  interfaceName: "PitRuntimeCapability",
  promptSummary: "runtime status",
  methods: {
    status: {
      callDescription: "Inspect Pi runtime status",
      declaration: "status(): Promise<{ mode: string; idle: boolean; pendingMessages: boolean }>;",
      documentation: "runtime.status() reports mode, idle state, and pending messages",
      minimumArguments: 0,
      maximumArguments: 0,
    },
  },
});
