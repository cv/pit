import { recordValue as object, stringValue as string } from "../shared/argument-values.js";

/** A change addressed by line anchors, which several may combine in one edit. */
export type AnchoredChange =
  | { kind: "replace"; start: string; end?: string; content: string }
  | { kind: "delete"; start: string; end?: string }
  | { kind: "insertBefore" | "insertAfter"; anchor: string; content: string };

type EditChange =
  | AnchoredChange
  | { kind: "replaceFile"; content: string }
  | { kind: "deleteFile" };

interface EditChangeSpec {
  revision: string | null;
  changes: EditChange[];
  /** Lines of context to return around each change, as hashed ranges. */
  context?: number;
}

/** Most context lines an edit may ask for on each side of a change. */
const MAX_EDIT_CONTEXT = 20;

export function isAnchoredChange(change: EditChange): change is AnchoredChange {
  return change.kind !== "replaceFile" && change.kind !== "deleteFile";
}

function lineSpan(change: Record<string, unknown>, label: string): { start: string; end?: string } {
  return {
    start: string(change.start, `${label}.start`),
    ...(change.end === undefined ? {} : { end: string(change.end, `${label}.end`) }),
  };
}

function parseChange(raw: unknown, index: number): EditChange {
  const label = `changes.changes[${index}]`;
  const change = object(raw, label);
  const kind = string(change.kind, `${label}.kind`);
  switch (kind) {
    case "replace":
      return {
        kind,
        ...lineSpan(change, label),
        content: string(change.content, `${label}.content`),
      };
    case "delete":
      return { kind, ...lineSpan(change, label) };
    case "insertBefore":
    case "insertAfter": {
      const content = string(change.content, `${label}.content`);
      if (!content) {
        throw new Error(`${label}.content must not be empty`);
      }
      return { kind, anchor: string(change.anchor, `${label}.anchor`), content };
    }
    case "replaceFile":
      return { kind, content: string(change.content, `${label}.content`) };
    case "deleteFile":
      return { kind };
    default:
      throw new Error(`Unknown edit change kind: ${kind}`);
  }
}

function isContext(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_EDIT_CONTEXT;
}

/** Validates the `changes` argument of `workspace.edit` and of each edit in a batch. */
export function parseEditSpec(raw: unknown): EditChangeSpec {
  const value = object(raw, "changes");
  const { revision, changes, context } = value;
  if (!(revision === null || typeof revision === "string")) {
    throw new TypeError("changes.revision must be a string or null");
  }
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new Error("changes.changes must be a non-empty array");
  }
  const parsed = changes.map((change: unknown, index) => parseChange(change, index));
  if (context !== undefined && !isContext(context)) {
    throw new TypeError(`changes.context must be an integer from 0 to ${MAX_EDIT_CONTEXT}`);
  }
  return { revision, changes: parsed, ...(context === undefined ? {} : { context }) };
}
