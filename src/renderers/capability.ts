import type { CapabilityCall } from "../capabilities/core.js";

export type { CapabilityCall } from "../capabilities/core.js";

import { getNativeFunction } from "../functions/native.js";
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
  return call ? getNativeFunction(`${call.capability}.${call.method}`)?.summary : undefined;
}

export function capabilityResultRenderer(
  call: CapabilityCall | undefined,
): ResultRendererKey | undefined {
  return call ? getNativeFunction(`${call.capability}.${call.method}`)?.resultRenderer : undefined;
}
