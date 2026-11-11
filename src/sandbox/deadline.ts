/**
 * A program's deadline that can pause: time while it is paused does not count. A host pauses it
 * while a call waits for a person, such as a dialog answered through a slow channel, so the
 * program's own work keeps its budget. Pauses nest; the clock runs again when the last one ends.
 */
export class ExecutionDeadline {
  readonly #controller = new AbortController();
  #remainingMs: number;
  #startedAt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #pauses = 0;
  #started = false;

  constructor(timeoutMs: number) {
    this.#remainingMs = timeoutMs;
  }

  /**
   * Aborts with a `TimeoutError`, as `AbortSignal.timeout()` does, once the time runs out. The
   * clock starts when the executor first reads it, so preparing the program does not count.
   */
  get signal(): AbortSignal {
    if (!this.#started) {
      this.#started = true;
      if (this.#pauses === 0) this.#start();
    }
    return this.#controller.signal;
  }

  /** Stops the clock until the returned function is called; calling it again does nothing. */
  pause(): () => void {
    if (this.#pauses++ === 0 && this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
      this.#remainingMs -= performance.now() - this.#startedAt;
    }
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      if (--this.#pauses === 0 && this.#started) this.#start();
    };
  }

  #start(): void {
    if (this.#controller.signal.aborted) return;
    this.#startedAt = performance.now();
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined;
        this.#controller.abort(
          new DOMException("The operation was aborted due to timeout", "TimeoutError"),
        );
      },
      Math.max(0, this.#remainingMs),
    );
    // Like AbortSignal.timeout(), the deadline alone does not keep the process alive.
    this.#timer.unref();
  }
}
