import type { FunctionExecutionContext } from "../execution/host-call-trace.js";

export interface WireMessage {
  type?: string;
  id?: number;
  namespace?: string;
  /** Legacy guest protocol spelling; accepted at ingress, never emitted. */
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

export type HostCallMessage = Omit<WireMessage, "capability"> &
  Required<Pick<WireMessage, "id" | "namespace" | "method" | "args">>;

export function parseHostCallMessage(message: WireMessage): HostCallMessage | undefined {
  const namespace = message.namespace === undefined ? message.capability : message.namespace;
  if (
    message.type !== "call" ||
    typeof message.id !== "number" ||
    typeof namespace !== "string" ||
    (message.capability !== undefined && message.capability !== namespace) ||
    typeof message.method !== "string" ||
    !Array.isArray(message.args)
  )
    return;
  const { capability: _legacy, ...canonical } = message;
  return { ...canonical, namespace, id: message.id, method: message.method, args: message.args };
}
