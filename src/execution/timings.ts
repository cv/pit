export type ExecutionPhase =
  | "formatting"
  | "preparation"
  | "validation"
  | "compilation"
  | "execution"
  | "commit"
  | "result";

/** Sequential invocation phases. Capability durations overlap execution and are not additive. */
export interface ExecutionTimings {
  totalMs: number;
  phases: Partial<Record<ExecutionPhase, number>>;
}

export class ExecutionTimingRecorder {
  readonly #now: () => number;
  readonly #startedAt: number;
  readonly #phases: ExecutionTimings["phases"] = {};
  #phase: ExecutionPhase = "formatting";
  #phaseStartedAt: number;
  #finishedAt: number | undefined;

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
    this.#startedAt = this.#phaseStartedAt = now();
  }

  enter(phase: ExecutionPhase): void {
    if (this.#finishedAt !== undefined) return;
    const now = this.#now();
    this.#phases[this.#phase] =
      (this.#phases[this.#phase] ?? 0) + Math.max(0, now - this.#phaseStartedAt);
    this.#phase = phase;
    this.#phaseStartedAt = now;
  }

  snapshot(): ExecutionTimings {
    const now = this.#finishedAt ?? this.#now();
    return {
      totalMs: Math.max(0, now - this.#startedAt),
      phases: {
        ...this.#phases,
        [this.#phase]: (this.#phases[this.#phase] ?? 0) + Math.max(0, now - this.#phaseStartedAt),
      },
    };
  }

  finish(): ExecutionTimings {
    this.#finishedAt ??= this.#now();
    return this.snapshot();
  }
}

/** Milliseconds keep fast calls distinguishable; long calls remain compact. */
export function formatDuration(durationMs: number): string {
  return durationMs < 1000
    ? `${Math.round(Math.max(0, durationMs))}ms`
    : `${(durationMs / 1000).toFixed(1)}s`;
}
