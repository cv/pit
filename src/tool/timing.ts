import type { RendererState, WithRendererState } from "./renderer-state.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 200;
const TIMING_STATE = Symbol("pit-timing");

type Phase = "generation" | "execution";

interface ActiveTimingState {
  startedAt?: number;
  completedAt?: number;
  timer?: ReturnType<typeof setInterval> | undefined;
}

export interface ToolCallTimingContext {
  argsComplete: boolean;
  executionStarted?: boolean;
  isPartial?: boolean;
  state?: unknown;
  invalidate?: () => void;
}

export interface ToolResultTimingContext {
  executionStarted?: boolean;
  isError?: boolean;
  state?: unknown;
  invalidate?: () => void;
}

interface PhaseClock {
  /** Whether this phase has ended, which stops its clock. */
  complete: boolean;
  /** Whether the row is final rather than still streaming or running. */
  finished: boolean;
  executionStarted: boolean | undefined;
  invalidate: (() => void) | undefined;
}

function spinnerFrame(elapsedMs: number): string {
  const index = Math.floor(Math.max(0, elapsedMs) / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[index] as (typeof SPINNER_FRAMES)[number];
}

function phaseState(state: RendererState, phase: Phase): ActiveTimingState {
  state[TIMING_STATE] ??= {};
  const phases = state[TIMING_STATE] as Partial<Record<Phase, ActiveTimingState>>;
  return (phases[phase] ??= {});
}

function activeTiming(
  state: ActiveTimingState,
  complete: boolean,
  invalidate?: () => void,
): { duration: string; spinner: string } {
  const now = Date.now();
  state.startedAt ??= now;
  if (complete) {
    state.completedAt ??= now;
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = undefined;
    }
  } else if (!state.timer && invalidate) {
    state.timer = setInterval(invalidate, SPINNER_INTERVAL_MS);
    (state.timer as { unref?: () => void }).unref?.();
  }
  const elapsed = (state.completedAt ?? now) - state.startedAt;
  return {
    duration: `${(Math.max(0, elapsed) / 1000).toFixed(1)}s`,
    spinner: spinnerFrame(elapsed),
  };
}

function phaseTiming(
  state: ActiveTimingState,
  clock: PhaseClock,
): { duration: string; spinner: string } {
  const timing = activeTiming(state, clock.complete, clock.invalidate);
  // A final row whose execution start was never observed was replayed from history: its clock
  // measured the replay, not the work.
  return clock.finished && clock.executionStarted === false
    ? { ...timing, duration: "time unavailable" }
    : timing;
}

export function generationTiming(context: WithRendererState<ToolCallTimingContext>): {
  duration: string;
  complete: boolean;
  spinner: string;
} {
  const complete =
    context.argsComplete || context.executionStarted === true || context.isPartial === false;
  if (context.executionStarted === true) {
    phaseState(context.state, "execution").startedAt ??= Date.now();
  }
  const timing = phaseTiming(phaseState(context.state, "generation"), {
    complete,
    // Generation can end before execution starts, so only a final row can be a replay.
    finished: context.isPartial === false,
    executionStarted: context.executionStarted,
    invalidate: context.invalidate,
  });
  return { ...timing, complete };
}

export function executionTiming(
  context: WithRendererState<ToolResultTimingContext>,
  complete: boolean,
): { duration: string; spinner: string } {
  return phaseTiming(phaseState(context.state, "execution"), {
    complete,
    finished: complete,
    executionStarted: context.executionStarted,
    invalidate: context.invalidate,
  });
}
