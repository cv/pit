const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 200;

interface ActiveTimingState {
  startedAt?: number;
  completedAt?: number;
  timer?: ReturnType<typeof setInterval> | undefined;
}

interface TypeScriptRendererState {
  generation?: ActiveTimingState;
  execution?: ActiveTimingState;
}

export interface ToolCallTimingContext {
  argsComplete: boolean;
  executionStarted?: boolean;
  isPartial?: boolean;
  state?: unknown;
  invalidate?: () => void;
}

export interface ToolResultTimingContext {
  isError?: boolean;
  state?: unknown;
  invalidate?: () => void;
}

function spinnerFrame(elapsedMs: number): string {
  const index = Math.floor(Math.max(0, elapsedMs) / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[index] as (typeof SPINNER_FRAMES)[number];
}

function rendererState(value: unknown): TypeScriptRendererState {
  return value && typeof value === "object" ? (value as TypeScriptRendererState) : {};
}

function timingState(
  state: TypeScriptRendererState,
  phase: keyof TypeScriptRendererState,
): ActiveTimingState {
  const timing = state[phase] ?? {};
  state[phase] = timing;
  return timing;
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

export function generationTiming(context: ToolCallTimingContext): {
  duration: string;
  complete: boolean;
  spinner: string;
} {
  const state = rendererState(context.state);
  const complete =
    context.argsComplete || context.executionStarted === true || context.isPartial === false;
  if (context.executionStarted === true) {
    timingState(state, "execution").startedAt ??= Date.now();
  }
  return {
    ...activeTiming(timingState(state, "generation"), complete, context.invalidate),
    complete,
  };
}

export function executionTiming(
  context: ToolResultTimingContext,
  complete: boolean,
): { duration: string; spinner: string } {
  const state = rendererState(context.state);
  return activeTiming(timingState(state, "execution"), complete, context.invalidate);
}
