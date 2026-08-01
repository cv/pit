import { truncateTail } from "@earendil-works/pi-coding-agent";
import { type CapabilityTrace, CapabilityTraceCollector } from "./capability-trace.js";
import { sanitizeTerminalText } from "./text-sanitization.js";
import type { ShellProgress } from "./typescript-tool-renderer.js";

export type HostShellProgressEvent =
  | { phase: "start" }
  | { phase: "output"; stream: "stdout" | "stderr"; chunk: string }
  | { phase: "end"; code: number };
export type ShellProgressEvent = HostShellProgressEvent & { id: number; command: string };
export interface ExecutionProgressDetails {
  progress?: ShellProgress[];
  traces?: CapabilityTrace[];
  tracesTruncated?: true;
}
type Update = (value: {
  content: Array<{ type: "text"; text: string }>;
  details: { value: undefined; truncated: false } & ExecutionProgressDetails;
}) => void;

export class ExecutionProgressController {
  readonly #traces = new CapabilityTraceCollector();
  readonly #shell = new Map<number, ShellProgress>();
  readonly #update: Update | undefined;
  #lastOutputUpdate = 0;

  constructor(update?: Update) {
    this.#update = update;
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

  details(): ExecutionProgressDetails {
    const trace = this.#traces.snapshot();
    return {
      ...(this.#shell.size ? { progress: [...this.#shell.values()] } : {}),
      ...(trace.traces.length ? { traces: trace.traces } : {}),
      ...(trace.truncated ? { tracesTruncated: true as const } : {}),
    };
  }

  #emit(): void {
    this.#update?.({
      content: [{ type: "text", text: "Running TypeScript…" }],
      details: { value: undefined, truncated: false, ...this.details() },
    });
  }
}
