import type { FunctionExecutionContext } from "../execution/capability-trace.js";

export interface WireMessage {
  type?: string;
  id?: number;
  capability?: string;
  method?: string;
  args?: unknown[];
  functionContext?: FunctionExecutionContext;
  value?: unknown;
  error?: string;
  /** Non-default error name for a string error, such as TimeoutError or AbortError. */
  errorName?: string;
  input?: unknown;
}

export type CapabilityCallMessage = WireMessage &
  Required<Pick<WireMessage, "id" | "capability" | "method" | "args">>;

export function isCapabilityCallMessage(message: WireMessage): message is CapabilityCallMessage {
  return (
    message.type === "call" &&
    typeof message.id === "number" &&
    typeof message.capability === "string" &&
    typeof message.method === "string" &&
    Array.isArray(message.args)
  );
}
