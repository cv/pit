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

export interface ExecutionProgressSnapshot {
  progress?: ShellProgress[];
  traces?: CapabilityTrace[];
  tracesTruncated?: true;
}

export type ExecutionProgressListener = (snapshot: ExecutionProgressSnapshot) => void;
