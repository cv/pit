import { LIMITS, sliceText } from "../shared/bounds.js";
import { sanitizeTerminalText } from "../shared/text-sanitization.js";
import { type CapabilityTrace, CapabilityTraceCollector } from "./capability-trace.js";
import type {
  ExecutionProgressListener,
  ExecutionProgressSnapshot,
  ShellProgress,
  ShellProgressEvent,
} from "./types.js";

const UPDATE_INTERVAL_MS = 200;
const MAX_COMPLETED_SHELL_CALLS = 32;
/** Live output kept per shell call, shown by progress views and retained-output sections. */
export function retainShellOutputTail(output: string): string {
  return sliceText(output, LIMITS.shellTail, "tail").text;
}

export class ExecutionProgressController {
  readonly #traces = new CapabilityTraceCollector();
  readonly #shell = new Map<number, ShellProgress>();
  readonly #listener: ExecutionProgressListener | undefined;
  #lastEmitAt: number | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #dirty: boolean = false;
  #disposed: boolean = false;
  #progressTruncated: boolean = false;

  constructor(listener?: ExecutionProgressListener) {
    this.#listener = listener;
  }

  recordTrace(trace: CapabilityTrace): void {
    if (this.#disposed) {
      return;
    }
    this.#traces.record(trace);
    this.#schedule();
  }

  recordShell(event: ShellProgressEvent): void {
    if (this.#disposed) {
      return;
    }
    const current: ShellProgress = this.#shell.get(event.id) ?? {
      id: event.id,
      ...(event.traceSequence === undefined ? {} : { traceSequence: event.traceSequence }),
      command: sanitizeTerminalText(event.command),
      status: "running" as const,
      output: "",
    };
    if (event.phase === "output") {
      const combined = current.output + sanitizeTerminalText(event.chunk, { preserveSgr: true });
      current.output = retainShellOutputTail(combined);
      // The tail is an exact suffix, so the dropped prefix is known; count it for the views.
      const dropped = combined.slice(0, combined.length - current.output.length);
      if (dropped) {
        current.omitted = {
          lines: (current.omitted?.lines ?? 0) + dropped.split("\n").length - 1,
          bytes: (current.omitted?.bytes ?? 0) + Buffer.byteLength(dropped),
          ...(dropped.endsWith("\n") ? {} : { partialLine: true as const }),
        };
      }
    }
    if (event.phase === "end") {
      current.status = "done";
      current.code = event.code;
    }
    this.#shell.set(event.id, current);
    if (event.phase === "end") {
      this.#pruneCompletedShellCalls();
    }
    this.#schedule();
  }

  snapshot(): ExecutionProgressSnapshot {
    const trace = this.#traces.snapshot();
    return {
      ...(this.#shell.size
        ? { progress: [...this.#shell.values()].map((entry) => Object.assign({}, entry)) }
        : {}),
      ...(this.#progressTruncated ? { progressTruncated: true as const } : {}),
      ...(trace.traces.length ? { traces: trace.traces } : {}),
      ...(trace.truncated ? { tracesTruncated: true as const } : {}),
    };
  }

  flush(): void {
    if (this.#disposed) {
      return;
    }
    this.#clearTimer();
    this.#emitNow();
  }

  dispose(): void {
    this.#clearTimer();
    this.#dirty = false;
    this.#disposed = true;
  }

  #schedule(): void {
    if (this.#disposed || !this.#listener) {
      return;
    }
    this.#dirty = true;
    const now = Date.now();
    // The first change emits immediately; burst changes share one trailing update.
    if (this.#lastEmitAt === undefined || now - this.#lastEmitAt >= UPDATE_INTERVAL_MS) {
      this.#clearTimer();
      this.#emitNow();
      return;
    }
    if (this.#timer === undefined) {
      this.#timer = setTimeout(
        () => {
          this.#timer = undefined;
          this.#emitNow();
        },
        UPDATE_INTERVAL_MS - (now - this.#lastEmitAt),
      );
    }
  }

  #emitNow(): void {
    if (this.#disposed || !this.#dirty || !this.#listener) {
      return;
    }
    this.#dirty = false;
    this.#lastEmitAt = Date.now();
    this.#listener(this.snapshot());
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  #pruneCompletedShellCalls(): void {
    const completed = [...this.#shell.values()].filter((entry) => entry.status === "done").length;
    if (completed <= MAX_COMPLETED_SHELL_CALLS) {
      return;
    }
    // Pruning follows every end event, so an over-limit map contains a completed entry.
    const [oldestCompletedId] = [...this.#shell].find(([, entry]) => entry.status === "done") as [
      number,
      ShellProgress,
    ];
    this.#shell.delete(oldestCompletedId);
    this.#progressTruncated = true;
  }
}
