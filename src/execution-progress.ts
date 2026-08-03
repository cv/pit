import { truncateTail } from "@earendil-works/pi-coding-agent";
import { type CapabilityTrace, CapabilityTraceCollector } from "./capability-trace.js";
import type {
  ExecutionProgressListener,
  ExecutionProgressSnapshot,
  ShellProgress,
  ShellProgressEvent,
  ToolProgress,
  ToolProgressEvent,
} from "./execution-types.js";
import { sanitizeTerminalText } from "./text-sanitization.js";

const UPDATE_INTERVAL_MS = 200;
const MAX_COMPLETED_SHELL_CALLS = 32;
const MAX_COMPLETED_TOOL_CALLS = 32;

function updateText(event: Extract<ToolProgressEvent, { phase: "update" }>): string {
  return (event.update.content ?? [])
    .flatMap((entry) => (entry.type === "text" ? [entry.text] : []))
    .join("\n");
}

export class ExecutionProgressController {
  readonly #traces = new CapabilityTraceCollector();
  readonly #shell = new Map<number, ShellProgress>();
  readonly #tools = new Map<string, ToolProgress>();
  readonly #listener: ExecutionProgressListener | undefined;
  #lastEmitAt: number | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #dirty: boolean = false;
  #disposed: boolean = false;
  #progressTruncated: boolean = false;
  #toolProgressTruncated: boolean = false;

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
    if (event.phase === "end") {
      this.#pruneCompletedShellCalls();
    }
    this.#schedule();
  }

  recordTool(event: ToolProgressEvent): void {
    if (this.#disposed) {
      return;
    }
    const current = this.#tools.get(event.toolCallId) ?? {
      toolCallId: event.toolCallId,
      name: event.name,
      status: "running" as const,
      updates: 0,
      output: "",
    };
    if (event.phase === "update") {
      current.updates += 1;
      const text = updateText(event);
      if (text) {
        current.output = truncateTail(
          current.output + (current.output ? "\n" : "") + sanitizeTerminalText(text),
          { maxBytes: 4000, maxLines: 8 },
        ).content;
      }
    } else {
      current.status = "done";
      current.isError = event.isError;
    }
    this.#tools.set(event.toolCallId, current);
    if (event.phase === "end") {
      this.#pruneCompletedToolCalls();
    }
    this.#schedule();
  }

  snapshot(): ExecutionProgressSnapshot {
    const trace = this.#traces.snapshot();
    return {
      ...(this.#shell.size
        ? { progress: [...this.#shell.values()].map((entry) => ({ ...entry })) }
        : {}),
      ...(this.#tools.size
        ? { toolProgress: [...this.#tools.values()].map((entry) => ({ ...entry })) }
        : {}),
      ...(this.#progressTruncated ? { progressTruncated: true as const } : {}),
      ...(this.#toolProgressTruncated ? { toolProgressTruncated: true as const } : {}),
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
    const [oldestCompletedId] = [...this.#shell].find(([, entry]) => entry.status === "done") as [
      number,
      ShellProgress,
    ];
    this.#shell.delete(oldestCompletedId);
    this.#progressTruncated = true;
  }

  #pruneCompletedToolCalls(): void {
    const completed = [...this.#tools.values()].filter((entry) => entry.status === "done").length;
    if (completed <= MAX_COMPLETED_TOOL_CALLS) {
      return;
    }
    const [oldestCompletedId] = [...this.#tools].find(([, entry]) => entry.status === "done") as [
      string,
      ToolProgress,
    ];
    this.#tools.delete(oldestCompletedId);
    this.#toolProgressTruncated = true;
  }
}
