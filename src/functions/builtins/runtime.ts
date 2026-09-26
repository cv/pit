import { defineNativeFunction } from "../native-definition.js";

export const runtimeFunctions = [
  defineNativeFunction("runtime", "status", {
    summary: "Inspect Pi runtime status",
    declaration: "status(): Promise<{ mode: string; idle: boolean; pendingMessages: boolean }>;",
    documentation: "runtime.status() reports mode, idle state, and pending messages",
    minimumArguments: 0,
    maximumArguments: 0,
  }),
] as const;
