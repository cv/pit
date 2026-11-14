/**
 * How hosts such as pi-action show `typescript` calls in a log: the call's label and program, and
 * the functions it injected and the value it returned as readable text. pi-durable does not read
 * this; hosts that do call it for stored entries, so it is synchronous, pure, and plain text.
 */
import { getFunctionDependencies } from "../functions/dependencies.js";
import { isRecord } from "../shared/records.js";
import { applySourceOptions } from "../tool/source-options.js";

/** The parts of a stored tool result that the presentation reads. */
export interface PresentedToolResult {
  content?: ReadonlyArray<{ type: string; text?: string }>;
  details?: unknown;
  isError?: boolean;
}

export interface ToolPresentation {
  call(args: unknown): { title: string; body?: string };
  result(args: unknown, result: PresentedToolResult): { summary?: string; body?: string };
}

/** Compact JSON longer than this goes on the lines after its key, indented. */
const COMPACT_JSON_LENGTH = 80;
const HEADER_LINE = /^[ \t]*\/\/ @pit:[^\r\n]*(?:\r?\n|$)/;

interface CallArguments {
  label?: string;
  code: string;
  params?: unknown;
  functionId?: string;
  saveOnly?: boolean;
}

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

/**
 * The call's arguments with the `// @pit:` header applied. Hosts may store the arguments as the
 * model sent them or as the tool prepared them; both give the same view. A malformed header,
 * which the tool rejected, still leaves the program shown without it.
 */
function callArguments(args: unknown): CallArguments {
  const record = isRecord(args) ? args : {};
  let applied: Record<string, unknown> = record;
  try {
    const prepared = applySourceOptions(record);
    if (isRecord(prepared)) applied = prepared;
  } catch {
    if (typeof record.code === "string") {
      applied = { ...record, code: record.code.replace(HEADER_LINE, "") };
    }
  }
  const code = typeof applied.code === "string" ? applied.code : "";
  return {
    ...(nonEmpty(applied.label) ? { label: applied.label.trim() } : {}),
    // Applying the header leaves an empty first line in its place.
    code: code.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd(),
    ...(applied.params === undefined || applied.params === null
      ? {}
      : { params: applied.params }),
    ...(nonEmpty(applied.functionId) ? { functionId: applied.functionId } : {}),
    ...(applied.saveOnly === true ? { saveOnly: true } : {}),
  };
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? line : `  ${line}`))
    .join("\n");
}

/** `key: value`, with multi-line strings as they are and long JSON indented on the lines after. */
function field(key: string, value: unknown): string {
  if (typeof value === "string") {
    return value.includes("\n") ? `${key}:\n${value.replace(/\n$/, "")}` : `${key}: ${value}`;
  }
  const compact = JSON.stringify(value) ?? String(value);
  if (compact.length <= COMPACT_JSON_LENGTH) return `${key}: ${compact}`;
  return `${key}:\n${indent(JSON.stringify(value, null, 2))}`;
}

/** A returned value for people: string fields as they are, not as escaped JSON. */
function readableValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (isRecord(value)) {
    const lines = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => field(key, entry));
    return lines.length > 0 ? lines.join("\n") : "{}";
  }
  return JSON.stringify(value, null, 2);
}

function resultText(result: PresentedToolResult): string {
  return (result.content ?? [])
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("")
    .trim();
}

/** The functions a program injects, such as `workspace.read · git.status`. */
function injected(code: string): string | undefined {
  try {
    const ids = getFunctionDependencies(code).dependencies.map(({ id }) => id);
    return ids.length > 0 ? ids.join(" · ") : undefined;
  } catch {
    return undefined;
  }
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? ""
  );
}

export const TYPESCRIPT_PRESENTATION: ToolPresentation = {
  call(args) {
    const call = callArguments(args);
    const sections = [
      call.code,
      ...(call.params === undefined ? [] : [field("params", call.params)]),
      ...(call.functionId === undefined ? [] : [`functionId: ${call.functionId}`]),
      ...(call.saveOnly ? ["saveOnly: true"] : []),
    ].filter((section) => section !== "");
    return {
      title: call.label ?? (firstLine(call.code) || "typescript"),
      ...(sections.length > 0 ? { body: sections.join("\n") } : {}),
    };
  },

  result(args, result) {
    const details = isRecord(result.details) ? result.details : {};
    if (result.isError) {
      const failure = isRecord(details.failure) ? details.failure : {};
      const text =
        resultText(result) || (typeof failure.rootError === "string" ? failure.rootError : "");
      return text === "" ? {} : { summary: firstLine(text), body: text };
    }
    const call = callArguments(args);
    const value = details.value;
    const saved =
      call.saveOnly && isRecord(value) && typeof value.savedFunction === "string"
        ? `saved ${value.savedFunction}`
        : undefined;
    const summary = saved ?? injected(call.code);
    const shown = "value" in details ? readableValue(value) : resultText(result) || undefined;
    const body =
      shown !== undefined && details.truncated === true
        ? `${shown}\n[Result truncated to fit the output budget]`
        : shown;
    return {
      ...(summary === undefined ? {} : { summary }),
      ...(body === undefined ? {} : { body }),
    };
  },
};
