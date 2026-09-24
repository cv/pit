/**
 * Termination errors carry their kind in the error name rather than in message wording. The names
 * match the DOMException names from AbortSignal.timeout() and AbortSignal.abort(), so native
 * platform errors classify the same way as Pit's own.
 */
export type TerminationKind = "timeout" | "cancelled";

const TERMINATION_NAMES = { timeout: "TimeoutError", cancelled: "AbortError" } as const;

export function terminationError(
  kind: TerminationKind,
  message: string,
  options?: ErrorOptions,
): Error {
  const error = new Error(message, options);
  error.name = TERMINATION_NAMES[kind];
  return error;
}

export function terminationKind(name: unknown): TerminationKind | undefined {
  if (name === TERMINATION_NAMES.timeout) return "timeout";
  if (name === TERMINATION_NAMES.cancelled) return "cancelled";
  return undefined;
}
