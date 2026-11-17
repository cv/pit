import {
  type AssistantMessage,
  COLLAPSED_CALLS_PREFIX,
  type ContextEdit,
  type ContextItem,
  type ContextView,
  ELIDED_CALLS_PREFIX,
  ELIDED_PREFIX,
  type EditProvenance,
  type Message,
  messageTokens,
  SUMMARY_PREFIX,
} from "./view.js";

export const MAX_EDIT_TARGETS = 200;
export const MAX_REASON_CHARS = 200;

/** A rewrite ready to write: the edits and what Pit records about them. */
export interface PlannedEdit {
  edits: ContextEdit[];
  provenance: EditProvenance;
}

export interface PlannedSummary extends PlannedEdit {
  summarizedEntries: number;
  summaryTokens: number;
}

export function formatTokens(tokens: number): string {
  return tokens >= 1_000 ? `${(tokens / 1_000).toFixed(1)}K` : String(tokens);
}

function textMessage(original: Message, text: string): Message {
  if (original.role === "assistant") {
    // No tool calls remain, so the turn reads as one that stopped.
    return { ...original, content: [{ type: "text", text }], stopReason: "stop" };
  }
  return { ...original, content: [{ type: "text", text }] } as Message;
}

function requireEditable(view: ContextView, id: string): ContextItem {
  const item = view.byId.get(id);
  if (!item) {
    throw new Error(
      view.activeIds.has(id)
        ? `Entry ${id} contributes nothing to the context`
        : `Entry ${id} is not in the active context`,
    );
  }
  if (item.protectedReason) {
    throw new Error(`Entry ${id} cannot be edited: ${item.protectedReason}`);
  }
  if (item.state !== "original") throw new Error(`Entry ${id} is already ${item.state}`);
  if (view.pending.has(id)) throw new Error(`Entry ${id} already has a staged rewrite`);
  return item;
}

function callResults(view: ContextView, item: ContextItem): ContextItem[] {
  return item.toolCallIds.flatMap((id) => {
    const result = view.results.get(id);
    return result ? [result] : [];
  });
}

/** The note that replaces an elided entry's tool calls and their results, as on Pi. */
function callNote(item: ContextItem, results: ContextItem[], reason?: string): string {
  const names = item.tools;
  const tokens = item.tokens + results.reduce((sum, result) => sum + result.tokens, 0);
  const failed = results.filter(
    (result) => (result.messages[0] as { isError?: boolean }).isError === true,
  ).length;
  const label =
    names.length === 1
      ? `${ELIDED_CALLS_PREFIX}: ${names[0]}`
      : `${ELIDED_CALLS_PREFIX}s: ${names.join(", ")}`;
  const withResults =
    results.length === 0 ? "" : results.length === 1 ? " with its result" : " with their results";
  const parts = [
    `${label} · ~${formatTokens(tokens)} tokens${withResults}`,
    ...(failed > 0 ? [`${failed} failed`] : []),
    ...(reason ? [`reason: ${reason}`] : []),
    `originals: ${[item.id, ...results.map((result) => result.id)].map((id) => `session.inspectEntry("${id}")`).join(", ")}`,
  ];
  return `${parts.join(" · ")}]`;
}

/** The most UTF-8 bytes a collapsed call's line takes, unless its entry IDs alone take more. */
export const MAX_COLLAPSED_LINE_BYTES = 512;
const MAX_TITLE_CHARS = 160;
const MAX_OUTCOME_CHARS = 160;

/** One finished call as its collapsed line names it. */
export interface CollapsedCall {
  tool: string;
  /** A `typescript` call's label, else its program's first line. */
  title?: string;
  functions: readonly string[];
  /** `ok`, `failed: <error's first line>`, or another short outcome. */
  outcome: string;
}

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;

function clip(text: string, chars: number): string {
  const line = text.replaceAll(/\s+/g, " ").trim();
  return line.length > chars ? `${line.slice(0, chars - 1).trimEnd()}…` : line;
}

/** `text` cut to `bytes` UTF-8 bytes at a code point, ending in "…"; only for text over the bound. */
function cutToBytes(text: string, bytes: number): string {
  let used = byteLength("…");
  let kept = "";
  for (const char of text) {
    used += byteLength(char);
    if (used > bytes) break;
    kept += char;
  }
  return `${kept.trimEnd()}…`;
}

function describeCall(call: CollapsedCall, functions: boolean, named: boolean): string {
  const title = call.title === undefined ? undefined : `"${clip(call.title, MAX_TITLE_CHARS)}"`;
  // With several calls each names its tool; a single call's tool is already in the line's head.
  const name = named ? [call.tool, ...(title === undefined ? [] : [title])].join(" ") : title;
  return [
    ...(name === undefined ? [] : [name]),
    ...(functions && call.functions.length > 0 ? [call.functions.join(", ")] : []),
    clip(call.outcome, MAX_OUTCOME_CHARS),
  ].join(" · ");
}

/**
 * The note that replaces a finished entry's tool calls and their results when Pit collapses them:
 * each call's label and outcome, their size, and how to read the originals, in one bounded line.
 * Over the bound, the injected functions go first, then the description is cut at its end; the
 * size and the entry IDs stay, the IDs in a shorter form when the usual one does not fit.
 */
export function collapsedCallNote(
  calls: readonly CollapsedCall[],
  tokens: number,
  ids: readonly string[],
): string {
  const head =
    calls.length === 1
      ? `${COLLAPSED_CALLS_PREFIX}${(calls[0] as CollapsedCall).tool} call`
      : `${COLLAPSED_CALLS_PREFIX}${calls.length} tool calls`;
  const line = (description: string, originals: string) =>
    `${head}${description === "" ? "" : ` · ${description}`} · ~${formatTokens(tokens)} tokens · ${originals}]`;
  const verbose =
    ids.length === 1
      ? `original: session.inspectEntry("${ids[0]}")`
      : `originals: ${ids.map((id) => `session.inspectEntry("${id}")`).join(", ")}`;
  const originals =
    byteLength(line("", verbose)) <= MAX_COLLAPSED_LINE_BYTES
      ? verbose
      : `originals: session.inspectEntry(id) for ${ids.map((id) => `"${id}"`).join(", ")}`;
  const named = calls.length > 1;
  for (const functions of [true, false]) {
    const full = line(
      calls.map((call) => describeCall(call, functions, named)).join("; "),
      originals,
    );
    if (byteLength(full) <= MAX_COLLAPSED_LINE_BYTES) return full;
  }
  const budget = MAX_COLLAPSED_LINE_BYTES - byteLength(line("", originals)) - byteLength(" · ");
  const description = calls.map((call) => describeCall(call, false, named)).join("; ");
  // When the IDs leave no room for a cut description and its "…", the line names none.
  return line(budget > byteLength("…") ? cutToBytes(description, budget) : "", originals);
}

export function elisionStub(id: string, tokens: number, reason?: string): string {
  const because = reason ? ` · reason: ${reason}` : "";
  return `${ELIDED_PREFIX} · ~${formatTokens(tokens)} tokens${because} · original: session.inspectEntry("${id}")]`;
}

function checkReason(reason: string | undefined): void {
  if (reason !== undefined && reason.length > MAX_REASON_CHARS) {
    throw new Error(`reason must be at most ${MAX_REASON_CHARS} characters`);
  }
}

/**
 * Elide entries. A tool result keeps its place, so its call stays answered, and shows a stub. An
 * assistant entry's tool calls become a plain-text note, and their results leave the context with
 * them, so the model sees neither a call to copy nor an unanswered one.
 */
export function planElide(view: ContextView, ids: readonly string[], reason?: string): PlannedEdit {
  checkReason(reason);
  if (ids.length === 0) throw new Error("elide needs at least one entry ID");
  if (ids.length > MAX_EDIT_TARGETS) {
    throw new Error(`elide takes at most ${MAX_EDIT_TARGETS} entries per call`);
  }
  const unique = [...new Set(ids)];
  // Results whose call is elided too leave with their call's note.
  const answered = new Set(
    unique.flatMap((id) => {
      const item = view.byId.get(id);
      return item?.role === "assistant" ? callResults(view, item).map((result) => result.id) : [];
    }),
  );
  const edits: ContextEdit[] = [];
  let tokensFreed = 0;
  for (const id of unique) {
    const item = requireEditable(view, id);
    const message = item.messages[0] as Message;
    if (item.role === "assistant" && item.toolCallIds.length > 0) {
      // Results follow their call, so they are editable when it is.
      const results = callResults(view, item);
      const note = callNote(item, results, reason);
      edits.push({
        target: item.entry.id,
        action: "replace",
        messages: [textMessage(message as AssistantMessage, note)],
      });
      for (const result of results) edits.push({ target: result.entry.id, action: "omit" });
      const kept = messageTokens(textMessage(message, note));
      tokensFreed += item.tokens + results.reduce((sum, result) => sum + result.tokens, 0) - kept;
      continue;
    }
    if (answered.has(item.id)) continue;
    const stub = elisionStub(id, item.tokens, reason);
    const replacement = textMessage(message, stub);
    edits.push({ target: item.entry.id, action: "replace", messages: [replacement] });
    tokensFreed += item.tokens - messageTokens(replacement);
  }
  return {
    edits,
    provenance: {
      operation: "elide",
      targets: unique,
      covers: edits.map((edit) => String(edit.target)),
      ...(reason ? { reason } : {}),
      tokensFreed: Math.max(0, tokensFreed),
    },
  };
}

/**
 * Replace a contiguous range with a summary: its first entry carries the summary and the rest leave
 * the context. A range must keep each tool call with its result.
 */
export function planSummarize(
  view: ContextView,
  input: { from: string; to: string; summary: string },
): PlannedSummary {
  const start = view.items.findIndex((item) => item.id === input.from);
  const end = view.items.findIndex((item) => item.id === input.to);
  if (start === -1) throw new Error(`Entry ${input.from} is not visible in the active context`);
  if (end === -1) throw new Error(`Entry ${input.to} is not visible in the active context`);
  if (end < start) throw new Error(`Entry ${input.from} comes after ${input.to}`);
  if (input.summary.trim() === "") throw new Error("summary must not be empty");
  const range = view.items.slice(start, end + 1);
  for (const item of range) requireEditable(view, item.id);
  const inRange = new Set(range.map((item) => item.id));
  for (const item of range) {
    for (const call of item.toolCallIds) {
      const partner =
        item.role === "toolResult"
          ? view.items.find(
              (candidate) => candidate.role === "assistant" && candidate.toolCallIds.includes(call),
            )
          : view.results.get(call);
      if (partner && !inRange.has(partner.id)) {
        throw new Error(
          `The range splits tool call ${call}: entries ${item.id} and ${partner.id} must both be in it or both outside`,
        );
      }
    }
  }
  const carrier = range[0] as ContextItem;
  const header = `${SUMMARY_PREFIX}${range.length} entries from ${input.from} to ${input.to} · originals: session.inspectEntry(id)]`;
  const replacement = textMessage(carrier.messages[0] as Message, `${header}\n${input.summary}`);
  const replacedTokens = range.reduce((sum, item) => sum + item.tokens, 0);
  const summaryTokens = messageTokens(replacement);
  if (summaryTokens >= replacedTokens) {
    throw new Error(
      `The summary (~${formatTokens(summaryTokens)} tokens) must be shorter than the ~${formatTokens(replacedTokens)} tokens it replaces`,
    );
  }
  return {
    edits: [
      { target: carrier.entry.id, action: "replace", messages: [replacement] },
      ...range.slice(1).map((item) => ({ target: item.entry.id, action: "omit" as const })),
    ],
    provenance: {
      operation: "summarize",
      targets: [input.from, input.to],
      carrier: carrier.id,
      covers: range.map((item) => item.id),
      tokensFreed: replacedTokens - summaryTokens,
    },
    summarizedEntries: range.length,
    summaryTokens,
  };
}
