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
  /** Exact tail of the combined output retained for display. */
  output: string;
  /**
   * Earlier output the retained tail dropped: complete lines and bytes. `partialLine` means the
   * tail starts inside a line, so only the byte count describes the omission exactly.
   */
  omitted?: { lines: number; bytes: number; partialLine?: true };
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
