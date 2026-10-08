import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { AppliedEdit } from "../execution/completed-calls.js";

/** File edits that one or more programs applied. */
export interface ResultEdits {
  /** The edits the results recorded. */
  readonly files: readonly AppliedEdit[];
  /** How many edits were applied: the recorded ones plus any past the cap. */
  readonly count: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isAppliedEdit(value: unknown): value is AppliedEdit {
  const edit = record(value);
  return (
    typeof edit?.file === "string" &&
    typeof edit.applied === "number" &&
    (typeof edit.revision === "string" || edit.revision === null)
  );
}

/** Edits a tool result's program applied, read from the original entry, never its stub. */
export function resultEdits(
  entry: Extract<SessionEntry, { type: "message" }>,
): ResultEdits | undefined {
  const details = record((entry.message as { details?: unknown }).details);
  if (!details) return undefined;
  const files = Array.isArray(details.edits) ? details.edits.filter(isAppliedEdit) : [];
  const omitted = typeof details.editsOmitted === "number" ? details.editsOmitted : 0;
  return files.length > 0 ? { files, count: files.length + omitted } : undefined;
}

/**
 * The file edits an assistant entry's tool calls applied, from the results that answer them.
 * Typed structurally, so a ContextView and its ContextItem fit without this module importing them.
 */
export function callEdits(
  view: { readonly results: ReadonlyMap<string, { readonly edits?: ResultEdits | undefined }> },
  item: { readonly toolCallIds: readonly string[] },
): ResultEdits | undefined {
  const files: AppliedEdit[] = [];
  let count = 0;
  for (const id of item.toolCallIds) {
    const edits = view.results.get(id)?.edits;
    if (!edits) continue;
    files.push(...edits.files);
    count += edits.count;
  }
  return count > 0 ? { files, count } : undefined;
}
