/**
 * Row-local state that Pi shares between one tool row's call and result renders. Pi creates it per
 * row; direct callers such as tests may omit it.
 */
export type RendererState = Record<PropertyKey, unknown>;

export type WithRendererState<C> = C & { state: RendererState };

/**
 * Installs row-local state on a context that lacks it, so later renders of that context, and copies
 * spread from it, share one state. Renderer entry points call this once; helpers take
 * `WithRendererState` and read `context.state` without replacing it.
 */
export function ensureRendererState<C extends { state?: unknown }>(
  context: C,
): asserts context is WithRendererState<C> {
  if (!context.state || typeof context.state !== "object") {
    (context as { state?: unknown }).state = {};
  }
}
