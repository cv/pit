/**
 * How hosts such as pi-action show `typescript` calls in a log: the call's label and program, and
 * the functions it injected and the value it returned as readable text. pi-durable does not read
 * this; hosts that do call it for stored entries, so it is synchronous, pure, and plain text. A
 * host falls back to its generic view when a function throws.
 */
import { getFunctionDependencies } from "../functions/dependencies.js";
import { isRecord } from "../shared/records.js";
import { applySourceOptions } from "../tool/source-options.js";

/** The parts of a stored tool result that the presentation reads. */
export interface PresentedToolResult {
  content: ReadonlyArray<{ type: string; text?: string }>;
  details?: unknown;
  isError?: boolean;
}

export interface ToolPresentation {
  call(args: unknown): { title: string; body: string };
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
  const record = args as Record<string, unknown> & { code: string };
  let applied: typeof record;
  try {
    applied = applySourceOptions(record) as typeof record;
  } catch {
    applied = { ...record, code: record.code.replace(HEADER_LINE, "") };
  }
  return {
    ...(nonEmpty(applied.label) ? { label: applied.label.trim() } : {}),
    // Applying the header leaves an empty first line in its place.
    code: applied.code.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd(),
    ...(applied.params === undefined || applied.params === null
      ? {}
      : { params: applied.params }),
    ...(nonEmpty(applied.functionId) ? { functionId: applied.functionId } : {}),
    ...(applied.saveOnly === true ? { saveOnly: true } : {}),
  };
}

/** `key: value`, with multi-line strings as they are and long JSON indented on the lines after. */
function field(key: string, value: unknown): string {
  if (typeof value === "string") {
    return value.includes("\n") ? `${key}:\n${value.replace(/\n$/, "")}` : `${key}: ${value}`;
  }
  const compact = JSON.stringify(value);
  if (compact.length <= COMPACT_JSON_LENGTH) return `${key}: ${compact}`;
  const indented = JSON.stringify(value, null, 2).replaceAll("\n", "\n  ");
  return `${key}:\n  ${indented}`;
}

/** A returned value for people: string fields as they are, not as escaped JSON. */
function readableValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value) && Object.keys(value).length > 0) {
    return Object.entries(value)
      .map(([key, entry]) => field(key, entry))
      .join("\n");
  }
  return JSON.stringify(value, null, 2);
}

function resultText(result: PresentedToolResult): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

const firstLine = (text: string) => (text.trimStart().split("\n", 1)[0] as string).trim();

export const TYPESCRIPT_PRESENTATION: ToolPresentation = {
  call(args) {
    const call = callArguments(args);
    return {
      title: call.label ?? firstLine(call.code),
      body: [
        call.code,
        ...(call.params === undefined ? [] : [field("params", call.params)]),
        ...(call.functionId === undefined ? [] : [`functionId: ${call.functionId}`]),
        ...(call.saveOnly ? ["saveOnly: true"] : []),
      ].join("\n"),
    };
  },

  result(args, result) {
    if (result.isError) {
      // The text is the root error, with the recovery notice when calls can be recovered.
      const text = resultText(result);
      return { summary: firstLine(text), body: text };
    }
    const call = callArguments(args);
    const details = result.details as { value?: unknown; truncated?: boolean };
    const summary = call.saveOnly
      ? `saved ${(details.value as { savedFunction: string }).savedFunction}`
      : getFunctionDependencies(call.code)
          .dependencies.map(({ id }) => id)
          .join(" · ");
    // A program that returns nothing has no value; its text says so.
    const shown = "value" in details ? readableValue(details.value) : resultText(result);
    return {
      ...(summary === "" ? {} : { summary }),
      body: details.truncated ? `${shown}\n[Result truncated to fit the output budget]` : shown,
    };
  },
};
