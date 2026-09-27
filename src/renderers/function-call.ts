import type { HostCallTrace } from "../execution/host-call-trace.js";
import type { FunctionCall } from "../functions/call.js";

export type { FunctionCall } from "../functions/call.js";

import { getGlobalFunction } from "../functions/globals.js";
import type { ResultRendererKey } from "./types.js";

const FUNCTION_CALL_PATTERN = /\b([A-Za-z_$][\w$]*)\.(\w+)\s*\(/;

export function inferFunctionCall(source: string): FunctionCall | undefined {
  const match = source.match(FUNCTION_CALL_PATTERN);
  if (!(match?.[1] && match[2])) {
    return;
  }
  return {
    namespace: match[1],
    method: match[2],
    qualifiedName: `${match[1]}.${match[2]}`,
  };
}

export function describeFunctionCall(call: FunctionCall | undefined): string | undefined {
  return call ? getGlobalFunction(`${call.namespace}.${call.method}`)?.summary : undefined;
}

export function functionResultRenderer(
  call: FunctionCall | undefined,
): ResultRendererKey | undefined {
  return call ? getGlobalFunction(`${call.namespace}.${call.method}`)?.resultRenderer : undefined;
}

export function runtimeFunctionCall(details: {
  traces?: HostCallTrace[];
  tracesTruncated?: boolean;
}): FunctionCall | undefined {
  if (!details.traces || details.tracesTruncated) {
    return;
  }
  const publicTraces = details.traces.filter((entry) => entry.namespace !== "__pit");
  if (publicTraces.length !== 1) {
    return;
  }
  const trace = publicTraces[0] as (typeof publicTraces)[number];
  // A package source wrapper declares the result contract; the trace still records the real
  // primitive effect. Never borrow that metadata for a same-named user/project/session override.
  const wrapper =
    trace.function?.scope === "global" ? getGlobalFunction(trace.function.name) : undefined;
  if (wrapper?.kind === "source") {
    return { namespace: wrapper.namespace, method: wrapper.method, qualifiedName: wrapper.id };
  }
  return {
    namespace: trace.namespace,
    method: trace.method,
    qualifiedName: `${trace.namespace}.${trace.method}`,
  };
}
