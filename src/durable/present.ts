/**
 * How hosts such as pi-action show `typescript` calls in a log: the call's label and program, and
 * the functions it injected and the value it returned as readable text. pi-durable does not read
 * this; hosts that do call it for stored entries, so it is synchronous, pure, and plain text. A
 * host passes whatever it stored, including results pi-durable wrote itself, so neither function
 * assumes the shape of Pit's own arguments or details.
 */
import { getFunctionDependencies } from "../functions/dependencies.js";
import { isRecord } from "../shared/records.js";
import { applySourceOptions } from "../tool/source-options.js";

/** The parts of a stored tool result that the presentation reads. */
export interface PresentedToolResult {
  content?: unknown;
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
const FUNCTION_NAME = /^\s*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/;

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
  const code = typeof record.code === "string" ? record.code : "";
  let applied: Record<string, unknown>;
  try {
    applied = { ...(applySourceOptions({ ...record, code }) as Record<string, unknown>) };
  } catch {
    applied = { ...record, code: code.replace(HEADER_LINE, "") };
  }
  return {
    ...(nonEmpty(applied.label) ? { label: applied.label.trim() } : {}),
    // Applying the header leaves an empty first line in its place.
    code: (applied.code as string).replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd(),
    ...(applied.params === undefined || applied.params === null ? {} : { params: applied.params }),
    ...(nonEmpty(applied.functionId) ? { functionId: applied.functionId.trim() } : {}),
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
  const content: unknown[] = Array.isArray(result.content) ? result.content : [];
  return content
    .map((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : "",
    )
    .join("")
    .trim();
}

const firstLine = (text: string) => (text.trimStart().split("\n", 1)[0] as string).trim();

/** The functions a program injects, such as `workspace.read · git.status`; none when it does not parse. */
function injected(code: string): string {
  try {
    return getFunctionDependencies(code)
      .dependencies.map(({ id }) => id)
      .join(" · ");
  } catch {
    return "";
  }
}

/** The function a `saveOnly` call saved: from its result, else its `functionId` or declaration. */
function savedName(call: CallArguments, value: unknown): string | undefined {
  if (isRecord(value) && nonEmpty(value.savedFunction)) return value.savedFunction;
  return call.functionId ?? FUNCTION_NAME.exec(call.code)?.[1];
}

function resultSummary(call: CallArguments, details: Record<string, unknown>): string {
  // A question ends the turn; the log says why.
  if (isRecord(details.question) && nonEmpty(details.question.title)) {
    return `asked: ${details.question.title}`;
  }
  if (call.saveOnly) {
    const name = savedName(call, details.value);
    return name === undefined ? "" : `saved ${name}`;
  }
  return injected(call.code);
}

export const TYPESCRIPT_PRESENTATION: ToolPresentation = {
  call(args) {
    const call = callArguments(args);
    return {
      title: call.label ?? (firstLine(call.code) || call.functionId || "typescript"),
      body: [
        call.code,
        ...(call.params === undefined ? [] : [field("params", call.params)]),
        ...(call.functionId === undefined ? [] : [`functionId: ${call.functionId}`]),
        ...(call.saveOnly ? ["saveOnly: true"] : []),
      ]
        .filter((section) => section !== "")
        .join("\n"),
    };
  },

  result(args, result) {
    const text = resultText(result);
    if (result.isError) {
      // The text is the root error, with the recovery notice when calls can be recovered.
      return text === "" ? {} : { summary: firstLine(text), body: text };
    }
    const call = callArguments(args);
    // Results pi-durable writes itself may carry no details, or details of another shape.
    const details = isRecord(result.details) ? result.details : {};
    const summary = resultSummary(call, details);
    // A program that returns nothing has no value; its text says so.
    const shown = "value" in details ? readableValue(details.value) : text;
    const body =
      details.truncated === true ? `${shown}\n[Result truncated to fit the output budget]` : shown;
    return {
      ...(summary === "" ? {} : { summary }),
      ...(body === "" ? {} : { body }),
    };
  },
};
