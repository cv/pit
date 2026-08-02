import { defineCapability } from "../capability-core.js";

export const runtimeCapability = defineCapability({
  interfaceName: "PitRuntimeCapability",
  promptSummary: "status/reload/shutdown requests",
  methods: {
    status: {
      callDescription: "Inspect Pi runtime status",
      declaration: "status(): Promise<{ mode: string; idle: boolean; pendingMessages: boolean }>;",
      documentation: "runtime.status() reports mode, idle state, and pending messages",
      minimumArguments: 0,
      maximumArguments: 0,
    },
    requestReload: {
      callDescription: "Request Pi reload",
      declaration: "requestReload(): Promise<{ queued: true; command: string }>;",
      documentation: "runtime.requestReload() queues a confirmed reload command",
      minimumArguments: 0,
      maximumArguments: 0,
    },
    requestShutdown: {
      callDescription: "Request Pi shutdown",
      declaration: "requestShutdown(): Promise<{ queued: true; command: string }>;",
      documentation: "runtime.requestShutdown() queues a confirmed graceful shutdown command",
      minimumArguments: 0,
      maximumArguments: 0,
    },
  },
});
