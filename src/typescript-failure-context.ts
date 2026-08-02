import { type ExtensionAPI, truncateHead } from "@earendil-works/pi-coding-agent";
import type { ExecutionProgressSnapshot } from "./execution-types.js";
import type { FunctionActivity } from "./saved-functions.js";

const MAX_FAILURE_BYTES = 8_000;
const MAX_FUNCTION_PATH = 32;
const SAVED_FAILURE_PREFIX = /^Saved function "([^"]+)" failed: /;
const CANCELLED_FAILURE = /abort|cancel/i;
const TIMEOUT_FAILURE = /timed? out|timeout/i;
const CAPABILITY_FAILURE = /command failed|capability|unknown capability/i;
const ERROR_PREFIX = /^Error:\s*/;
const STACK_TRACE = /\n\s+at /;

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
  rootError = rootError.replace(ERROR_PREFIX, "");
  const stackStart = rootError.search(STACK_TRACE);
  if (stackStart >= 0) {
    rootError = rootError.slice(0, stackStart);
  }
  const functionPath: string[] = [];
  for (;;) {
    const match = rootError.match(SAVED_FAILURE_PREFIX);
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
  rootError = truncateHead(rootError, { maxBytes: MAX_FAILURE_BYTES, maxLines: 80 }).content;
  return {
    functionPath: functionPath.slice(0, MAX_FUNCTION_PATH),
    rootError,
    kind: failureKind(rootError),
  };
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
