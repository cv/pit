import { defineNativeFunction } from "../global-definition.js";

export const runtimeFunctions = [
  defineNativeFunction("runtime", "status", {
    summary: "Inspect Pi runtime status",
    declaration: "status(): Promise<{ mode: string; idle: boolean; pendingMessages: boolean }>;",
    documentation: "runtime.status() reports mode, idle state, and pending messages",
    minimumArguments: 0,
    maximumArguments: 0,
  }),
  defineNativeFunction("runtime", "completedCalls", {
    summary: "Recover a failed program's completed calls",
    declaration: `completedCalls(
  toolCallId: string,
  options?: { sequence?: number },
): Promise<{
  toolCallId: string;
  calls: Array<{ sequence: number; call: string; value: PitJsonValue }>;
  omitted: number;
}>;`,
    documentation:
      "runtime.completedCalls(toolCallId, { sequence? }) returns results of calls a failed program completed, so they need not be repeated",
    minimumArguments: 1,
    maximumArguments: 2,
  }),
] as const;
