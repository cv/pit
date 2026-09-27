import type { CapabilityCall } from "../capabilities/core.js";
import type { CapabilityTrace } from "../execution/capability-trace.js";

export type { CapabilityCall } from "../capabilities/core.js";

import { getGlobalFunction } from "../functions/globals.js";
import type { ResultRendererKey } from "./types.js";

const CAPABILITY_CALL_PATTERN = /\b([A-Za-z_$][\w$]*)\.(\w+)\s*\(/;

export function inferCapabilityCall(source: string): CapabilityCall | undefined {
  const match = source.match(CAPABILITY_CALL_PATTERN);
  if (!(match?.[1] && match[2])) {
    return;
  }
  return {
    capability: match[1],
    method: match[2],
    qualifiedName: `${match[1]}.${match[2]}`,
  };
}

export function describeCapabilityCall(call: CapabilityCall | undefined): string | undefined {
  return call ? getGlobalFunction(`${call.capability}.${call.method}`)?.summary : undefined;
}

export function capabilityResultRenderer(
  call: CapabilityCall | undefined,
): ResultRendererKey | undefined {
  return call ? getGlobalFunction(`${call.capability}.${call.method}`)?.resultRenderer : undefined;
}

export function runtimeCapabilityCall(details: {
  traces?: CapabilityTrace[];
  tracesTruncated?: boolean;
}): CapabilityCall | undefined {
  if (!details.traces || details.tracesTruncated) {
    return;
  }
  const publicTraces = details.traces.filter((entry) => entry.capability !== "__pit");
  if (publicTraces.length !== 1) {
    return;
  }
  const trace = publicTraces[0] as (typeof publicTraces)[number];
  // A package source wrapper declares the result contract; the trace still records the real
  // primitive effect. Never borrow that metadata for a same-named user/project/session override.
  const wrapper =
    trace.function?.scope === "global" ? getGlobalFunction(trace.function.name) : undefined;
  if (wrapper?.kind === "source") {
    return { capability: wrapper.capability, method: wrapper.method, qualifiedName: wrapper.id };
  }
  return {
    capability: trace.capability,
    method: trace.method,
    qualifiedName: `${trace.capability}.${trace.method}`,
  };
}
