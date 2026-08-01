import { truncateTail } from "@earendil-works/pi-coding-agent";
import { type CapabilityTrace, CapabilityTraceCollector } from "./capability-trace.js";
import type {
  ExecutionProgressListener,
  ExecutionProgressSnapshot,
  ShellProgress,
  ShellProgressEvent,
} from "./execution-types.js";
import { sanitizeTerminalText } from "./text-sanitization.js";

export class ExecutionProgressController {
  readonly #traces = new CapabilityTraceCollector();
  readonly #shell = new Map<number, ShellProgress>();
  readonly #listener: ExecutionProgressListener | undefined;
  #lastOutputUpdate = 0;

  constructor(listener?: ExecutionProgressListener) {
    this.#listener = listener;
  }

  recordTrace(trace: CapabilityTrace): void {
    this.#traces.record(trace);
    this.#emit();
  }

  recordShell(event: ShellProgressEvent): void {
    const current = this.#shell.get(event.id) ?? {
      id: event.id,
      command: sanitizeTerminalText(event.command),
      status: "running" as const,
      output: "",
    };
    if (event.phase === "output") {
      current.output = truncateTail(current.output + sanitizeTerminalText(event.chunk), {
        maxBytes: 4000,
        maxLines: 8,
      }).content;
    }
    if (event.phase === "end") {
      current.status = "done";
      current.code = event.code;
    }
    this.#shell.set(event.id, current);
    const now = Date.now();
    if (event.phase !== "output" || now - this.#lastOutputUpdate >= 100) {
      this.#lastOutputUpdate = now;
      this.#emit();
    }
  }

  snapshot(): ExecutionProgressSnapshot {
    const trace = this.#traces.snapshot();
    return {
      ...(this.#shell.size
        ? { progress: [...this.#shell.values()].map((entry) => ({ ...entry })) }
        : {}),
      ...(trace.traces.length ? { traces: trace.traces } : {}),
      ...(trace.truncated ? { tracesTruncated: true as const } : {}),
    };
  }

  #emit(): void {
    this.#listener?.(this.snapshot());
  }
}
