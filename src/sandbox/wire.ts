/**
 * Pit's bridge protocol: every request a guest makes through `pitCall()` is one JSON frame, and
 * every host-call answer is one JSON frame back.
 */

export interface HostCallMessage {
  type: "call";
  id: number;
  namespace: string;
  method: string;
  args: unknown[];
  /** The calling saved-function invocation, checked by the host before it is trusted. */
  functionContext?: unknown;
}

export interface HostCallResponse {
  type: "response";
  id: number;
  value?: unknown;
  error?: string;
  /** Non-default error name for a string error, such as TimeoutError or AbortError. */
  errorName?: string;
}

export type GuestRequest =
  | HostCallMessage
  | { type: "timer"; delayMs: number }
  | { type: "result"; value: unknown };

/** The request a parsed guest frame holds, or undefined when it is not a valid one. */
export function parseGuestRequest(value: Record<string, unknown>): GuestRequest | undefined {
  switch (value.type) {
    case "call":
      return typeof value.id === "number" &&
        typeof value.namespace === "string" &&
        typeof value.method === "string" &&
        Array.isArray(value.args)
        ? (value as unknown as HostCallMessage)
        : undefined;
    case "timer":
      return Number.isSafeInteger(value.delayMs) && Number(value.delayMs) >= 0
        ? { type: "timer", delayMs: Number(value.delayMs) }
        : undefined;
    case "result":
      return { type: "result", value: value.value };
    default:
      return undefined;
  }
}
