import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { CapabilityTrace } from "./capability-trace.js";

export type HostShellProgressEvent =
  | { phase: "start" }
  | { phase: "output"; stream: "stdout" | "stderr"; chunk: string }
  | { phase: "end"; code: number };

export type ShellProgressEvent = HostShellProgressEvent & { id: number; command: string };

export interface ShellProgress {
  id: number;
  command: string;
  status: "running" | "done";
  output: string;
  code?: number;
}

export type ToolProgressEvent =
  | {
      phase: "update";
      name: string;
      toolCallId: string;
      update: AgentToolResult<unknown>;
    }
  | { phase: "end"; name: string; toolCallId: string; isError: boolean };

export interface ToolProgress {
  toolCallId: string;
  name: string;
  status: "running" | "done";
  updates: number;
  output: string;
  isError?: boolean;
}

export interface ExecutionProgressSnapshot {
  progress?: ShellProgress[];
  toolProgress?: ToolProgress[];
  traces?: CapabilityTrace[];
  progressTruncated?: true;
  toolProgressTruncated?: true;
  tracesTruncated?: true;
}

export type ExecutionProgressListener = (snapshot: ExecutionProgressSnapshot) => void;
