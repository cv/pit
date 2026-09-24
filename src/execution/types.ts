import type { CapabilityTrace } from "./capability-trace.js";
import type { ExecutionTimings } from "./timings.js";

export type HostShellProgressEvent =
  | { phase: "start" }
  | { phase: "output"; stream: "stdout" | "stderr"; chunk: string }
  | { phase: "end"; code: number };

export type ShellProgressEvent = HostShellProgressEvent & {
  id: number;
  command: string;
  traceSequence?: number;
};

export interface ShellProgress {
  id: number;
  /** Capability sequence owning this process; absent in legacy sessions. */
  traceSequence?: number;
  command: string;
  status: "running" | "done";
  output: string;
  code?: number;
}

export interface ExecutionProgressSnapshot {
  timings?: ExecutionTimings;
  progress?: ShellProgress[];
  traces?: CapabilityTrace[];
  progressTruncated?: true;
  tracesTruncated?: true;
}

export type ExecutionProgressListener = (snapshot: ExecutionProgressSnapshot) => void;
