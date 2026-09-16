import { Worker } from "node:worker_threads";

const REGEX_WORKER_TIMEOUT_MS = 250;
const REGEX_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const expression = new RegExp(workerData.query, workerData.flags);
parentPort.on("message", ({ id, lines, limit }) => {
  try {
    const matches = [];
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const text = lines[lineIndex];
      expression.lastIndex = 0;
      for (;;) {
        const match = expression.exec(text);
        if (!match) break;
        matches.push({ lineIndex, column: match.index });
        if (matches.length >= limit) {
          parentPort.postMessage({ id, matches });
          return;
        }
        if (match[0].length === 0) expression.lastIndex++;
      }
    }
    parentPort.postMessage({ id, matches });
  } catch (error) {
    parentPort.postMessage({ id, error: error?.message ?? String(error) });
  }
});
`;

export interface RegexLineMatch {
  lineIndex: number;
  column: number;
}

interface WorkerResponse {
  id?: unknown;
  matches?: unknown;
  error?: unknown;
}

interface PendingMatch {
  resolve: (matches: RegexLineMatch[]) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class InterruptibleRegexMatcher {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingMatch>();
  private nextId = 1;
  private closed = false;

  constructor(query: string, caseSensitive: boolean) {
    this.worker = new Worker(REGEX_WORKER_SOURCE, {
      eval: true,
      workerData: { query, flags: caseSensitive ? "g" : "gi" },
      resourceLimits: { maxOldGenerationSizeMb: 32 },
    });
    this.worker.on("message", (message: WorkerResponse) => this.handleMessage(message));
    this.worker.on("error", (error) =>
      this.fail(error instanceof Error ? error : new Error(String(error))),
    );
    this.worker.on("exit", (code) => {
      if (!this.closed && code !== 0) {
        this.fail(new Error(`Regex worker stopped with exit code ${code}`));
      }
    });
  }

  match(lines: string[], limit: number): Promise<RegexLineMatch[]> {
    if (limit < 1) {
      return Promise.resolve([]);
    }
    if (this.closed) {
      return Promise.reject(new Error("Regex worker is closed"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Regex search exceeded ${REGEX_WORKER_TIMEOUT_MS}ms`));
        this.fail(new Error("Regex search worker was terminated"));
        void this.worker.terminate();
      }, REGEX_WORKER_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, lines, limit });
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.fail(new Error("Regex worker closed"));
    await this.worker.terminate();
  }

  private handleMessage(message: WorkerResponse): void {
    if (typeof message.id !== "number") {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (typeof message.error === "string") {
      pending.reject(new Error(message.error));
      return;
    }
    if (!Array.isArray(message.matches)) {
      pending.reject(new Error("Regex worker returned an invalid response"));
      return;
    }
    pending.resolve(message.matches as RegexLineMatch[]);
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
