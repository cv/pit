import type { FunctionExecutionContext } from "../execution/host-call-trace.js";

export interface WireMessage {
  type?: string;
  id?: number;
  namespace?: string;
  method?: string;
  args?: unknown[];
  functionContext?: FunctionExecutionContext;
  value?: unknown;
  error?: string;
  /** Non-default error name for a string error, such as TimeoutError or AbortError. */
  errorName?: string;
  input?: unknown;
}

export type HostCallMessage = WireMessage &
  Required<Pick<WireMessage, "id" | "namespace" | "method" | "args">>;

export function isHostCallMessage(message: WireMessage): message is HostCallMessage {
  return (
    message.type === "call" &&
    typeof message.id === "number" &&
    typeof message.namespace === "string" &&
    typeof message.method === "string" &&
    Array.isArray(message.args)
  );
}
