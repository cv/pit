import { getCapabilityMethodDefinition } from "./capability-registry.js";
import type { ResultRendererKey } from "./result-renderer-types.js";

export interface CapabilityCall {
  capability: string;
  method: string;
  qualifiedName: string;
}

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
  return call
    ? getCapabilityMethodDefinition(call.capability, call.method)?.callDescription
    : undefined;
}

export function capabilityResultRenderer(
  call: CapabilityCall | undefined,
): ResultRendererKey | undefined {
  return call
    ? getCapabilityMethodDefinition(call.capability, call.method)?.resultRenderer
    : undefined;
}
