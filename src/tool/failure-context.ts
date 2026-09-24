import { type ExtensionAPI, truncateHead, truncateTail } from "@earendil-works/pi-coding-agent";

import type { ExecutionProgressSnapshot } from "../execution/types.js";
import type { FunctionActivity } from "../functions/core.js";
import { terminationKind } from "../shared/termination-errors.js";
import { sanitizeTerminalText } from "../shared/text-sanitization.js";

const MAX_FAILURE_BYTES = 8_000;
const MAX_FAILURE_LINES = 24;
const MAX_FUNCTION_PATH = 32;
const OMITTED_DIAGNOSTIC = "… diagnostic middle omitted before rendering; not retained …";
const OMITTED_CALLS = "… further calls not retained …";
// Head and tail halves, joined by newline-delimited omission markers, stay within the maximums.
const DIAGNOSTIC_HALF = {
  maxBytes: Math.floor((MAX_FAILURE_BYTES - Buffer.byteLength(OMITTED_DIAGNOSTIC) - 2) / 2),
  maxLines: Math.floor((MAX_FAILURE_LINES - 1) / 2),
};
const PATH_HEAD = Math.ceil((MAX_FUNCTION_PATH - 1) / 2);
const PATH_TAIL = MAX_FUNCTION_PATH - 1 - PATH_HEAD;
const FUNCTION_FAILURE_PREFIX = /^(?:Saved function|Function) "([^"]+)" failed: /;
const CAPABILITY_FAILURE = /^(?:command failed|(?:unknown |missing |invalid )?capability)\b/i;
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

function errorName(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  // The Node executor wraps guest errors and keeps the guest error name separately.
  const remoteName = (error as { remoteName?: unknown }).remoteName;
  return typeof remoteName === "string" ? remoteName : error.name;
}

function failureKind(message: string, name?: string): StructuredTypeScriptFailure["kind"] {
  // Terminations are identified by error name, carried from their source through the guest.
  const termination = terminationKind(name);
  if (termination) return termination;
  // Classify the diagnostic headline, never source excerpts, paths, or stack frames.
  const headline = (message.split("\n", 1)[0] ?? "").trim();
  if (CAPABILITY_FAILURE.test(headline)) return "capability";
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
  const kind = failureKind(rootError, errorName(error));
  const bounded = truncateHead(rootError, {
    maxBytes: MAX_FAILURE_BYTES,
    maxLines: MAX_FAILURE_LINES,
  });
  if (bounded.truncated) {
    const head = truncateHead(rootError, DIAGNOSTIC_HALF).content;
    const tail = truncateTail(rootError, DIAGNOSTIC_HALF).content;
    rootError = `${head}\n${OMITTED_DIAGNOSTIC}\n${tail}`;
  }
  const boundedPath =
    functionPath.length > MAX_FUNCTION_PATH
      ? [...functionPath.slice(0, PATH_HEAD), OMITTED_CALLS, ...functionPath.slice(-PATH_TAIL)]
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
