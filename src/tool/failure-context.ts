import { type ExtensionAPI, truncateHead, truncateTail } from "@earendil-works/pi-coding-agent";

import type { ExecutionProgressSnapshot } from "../execution/types.js";
import type { FunctionActivity } from "../functions/core.js";
import { sanitizeTerminalText } from "../shared/text-sanitization.js";

const MAX_FAILURE_BYTES = 8_000;
const MAX_FAILURE_LINES = 24;
const MAX_FUNCTION_PATH = 32;
const FUNCTION_FAILURE_PREFIX = /^(?:Saved function|Function) "([^"]+)" failed: /;
const CANCELLED_FAILURE = /abort|cancel/i;
const TIMEOUT_FAILURE = /timed? out|timeout/i;
const CAPABILITY_FAILURE = /command failed|capability|unknown capability/i;
const ERROR_PREFIX = /^Error:\s*/;

export interface StructuredTypeScriptFailure {
  functionPath: string[];
  rootError: string;
  kind: "cancelled" | "timeout" | "capability" | "user";
}

export interface TypeScriptFailureDetails extends ExecutionProgressSnapshot {
  value: undefined;
  truncated: false;
  functions?: FunctionActivity[];
  failure: StructuredTypeScriptFailure;
}

function failureKind(message: string): StructuredTypeScriptFailure["kind"] {
  if (CANCELLED_FAILURE.test(message)) {
    return "cancelled";
  }
  if (TIMEOUT_FAILURE.test(message)) {
    return "timeout";
  }
  if (CAPABILITY_FAILURE.test(message)) {
    return "capability";
  }
  return "user";
}

export function structureTypeScriptFailure(
  error: unknown,
  activity: readonly FunctionActivity[],
): StructuredTypeScriptFailure {
  let rootError = error instanceof Error ? error.message : String(error);
  rootError = sanitizeTerminalText(rootError).replace(ERROR_PREFIX, "");
  const functionPath: string[] = [];
  for (;;) {
    const match = rootError.match(FUNCTION_FAILURE_PREFIX);
    const name = match?.[1];
    if (!(match && name)) {
      break;
    }
    functionPath.push(name);
    rootError = rootError.slice(match[0].length);
  }
  if (functionPath.length === 0) {
    for (const entry of activity) {
      if (entry.action === "run" && !functionPath.includes(entry.name)) {
        functionPath.push(entry.name);
      }
    }
  }
  const kind = failureKind(rootError);
  const bounded = truncateHead(rootError, {
    maxBytes: MAX_FAILURE_BYTES,
    maxLines: MAX_FAILURE_LINES,
  });
  if (bounded.truncated) {
    const limits = { maxBytes: 3_500, maxLines: 11 };
    rootError = `${truncateHead(rootError, limits).content}\n… diagnostic middle omitted before rendering; not retained …\n${truncateTail(rootError, limits).content}`;
  }
  const boundedPath =
    functionPath.length > MAX_FUNCTION_PATH
      ? [...functionPath.slice(0, 16), "… further calls not retained …", ...functionPath.slice(-15)]
      : functionPath;
  return { functionPath: boundedPath, rootError, kind };
}

export function captureTypeScriptFailure(
  error: unknown,
  activity: readonly FunctionActivity[],
  progress: ExecutionProgressSnapshot,
): TypeScriptFailureDetails {
  return {
    value: undefined,
    truncated: false,
    ...(activity.length > 0 ? { functions: [...activity] } : {}),
    ...progress,
    failure: structureTypeScriptFailure(error, activity),
  };
}

export function registerTypeScriptFailureEnrichment(
  pi: ExtensionAPI,
  pending: Map<string, TypeScriptFailureDetails>,
): void {
  pi.on("tool_result", (event) => {
    if (!(event.toolName === "typescript" && event.isError)) {
      return;
    }
    const details = pending.get(event.toolCallId);
    if (!details) {
      return;
    }
    pending.delete(event.toolCallId);
    return {
      content: [{ type: "text" as const, text: details.failure.rootError }],
      details,
    };
  });
}
