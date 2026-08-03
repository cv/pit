import type { ChildProcessWithoutNullStreams } from "node:child_process";

interface SandboxLifecycleOptions {
  child: ChildProcessWithoutNullStreams;
  timeoutMs: number;
  signal?: AbortSignal;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class SandboxLifecycle {
  readonly capabilitySignal: AbortSignal;
  readonly #capabilityController = new AbortController();
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #signal: AbortSignal | undefined;
  readonly #resolve: (value: unknown) => void;
  readonly #reject: (error: Error) => void;
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #onAbort: () => void;
  #settled = false;

  constructor(options: SandboxLifecycleOptions) {
    this.#child = options.child;
    this.#signal = options.signal;
    this.#resolve = options.resolve;
    this.#reject = options.reject;
    this.capabilitySignal = options.signal
      ? AbortSignal.any([options.signal, this.#capabilityController.signal])
      : this.#capabilityController.signal;
    this.#onAbort = () => this.finish(new Error("TypeScript execution cancelled"));
    this.#timer = setTimeout(
      () => this.finish(new Error(`TypeScript execution timed out after ${options.timeoutMs}ms`)),
      options.timeoutMs,
    );
    this.#timer.unref?.();
    options.signal?.addEventListener("abort", this.#onAbort, { once: true });
    if (options.signal?.aborted) {
      this.#onAbort();
    }
  }

  get settled(): boolean {
    return this.#settled;
  }

  finish(error?: Error, value?: unknown): void {
    /* v8 ignore next -- only asynchronous child-process races finish twice. */
    // biome-ignore lint/suspicious/noUnnecessaryConditions: asynchronous finish paths can race.
    if (this.#settled) {
      return;
    }
    this.#settled = true;
    this.#capabilityController.abort();
    clearTimeout(this.#timer);
    this.#signal?.removeEventListener("abort", this.#onAbort);
    this.#child.kill("SIGKILL");
    if (error) {
      this.#reject(error);
    } else {
      this.#resolve(value);
    }
  }

  finishAfter(pending: Promise<void>[], error?: Error, value?: unknown): void {
    void Promise.allSettled(pending).then(() => this.finish(error, value));
  }
}
