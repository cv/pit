import { estimateTokens } from "@earendil-works/pi-coding-agent";

import {
  describeMissing,
  formatTokens,
  type PlannedEdit,
  PlanProblems,
  reprefillAfter,
  type CacheBasis,
} from "./planning.js";
import { callEdits, type ResultEdits } from "./result-edits.js";
import {
  type AgentMessage,
  type AssistantMessage,
  type ContextItem,
  type ContextView,
  ELIDED_CALLS_PREFIX,
  ELIDED_PREFIX,
  type EditableContent,
} from "./view.js";

export const MAX_REASON_CHARS = 200;

export function elisionStub(id: string, tokens: number, reason?: string): string {
  const because = reason ? ` · reason: ${reason}` : "";
  return `${ELIDED_PREFIX} · ~${formatTokens(tokens)} tokens${because} · original: session.inspectEntry("${id}")]`;
}

/** The results that answer an assistant entry's tool calls, in call order. */
function callResults(view: ContextView, item: ContextItem): ContextItem[] {
  return item.toolCallIds.flatMap((id) => {
    const result = view.results.get(id);
    return result ? [result] : [];
  });
}

/**
 * The note that replaces an elided entry's tool calls and their results. It is plain text, not a
 * tool call, so a model sees nothing it could copy as a call (#292), and it reads as an omission,
 * not as code, so a model does not mistake it for a program that ran (#222).
 */
function callNote(view: ContextView, item: ContextItem, reason?: string): string {
  const message = item.messages[0] as AssistantMessage;
  const names = message.content.flatMap((block) => (block.type === "toolCall" ? [block.name] : []));
  const results = callResults(view, item);
  const tokens = argumentTokens(message) + results.reduce((sum, result) => sum + result.tokens, 0);
  const failed = results.filter(
    (result) => (result.messages[0] as { isError?: boolean }).isError === true,
  ).length;
  const edits = callEdits(view, item);
  const label =
    names.length === 1
      ? `${ELIDED_CALLS_PREFIX}: ${names[0]}`
      : `${ELIDED_CALLS_PREFIX}s: ${names.join(", ")}`;
  const withResults =
    results.length === 0 ? "" : results.length === 1 ? " with its result" : " with their results";
  const parts = [
    `${label} · ~${formatTokens(tokens)} tokens${withResults}`,
    ...(edits ? [appliedEdits(edits)] : []),
    ...(failed > 0 ? [`${failed} failed`] : []),
    ...(reason ? [`reason: ${reason}`] : []),
    `originals: ${[item.id, ...results.map((result) => result.id)].map((id) => `session.inspectEntry("${id}")`).join(", ")}`,
  ];
  return `${parts.join(" · ")}]`;
}

const MAX_STUB_FILES = 6;
const MAX_STUB_PATH_CHARS = 120;

/** Which files an elided call's edits changed, so the trail stays readable without its payload. */
function appliedEdits(edits: ResultEdits): string {
  const shown = edits.files.slice(0, MAX_STUB_FILES).map((edit) => {
    const file =
      edit.file.length > MAX_STUB_PATH_CHARS
        ? `…${edit.file.slice(-MAX_STUB_PATH_CHARS)}`
        : edit.file;
    if (edit.deleted) return `${file} deleted`;
    const changes = `${edit.applied} change${edit.applied === 1 ? "" : "s"}`;
    return `${file} @ ${edit.revision} (${changes})`;
  });
  const more = edits.count - shown.length;
  return `applied: ${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}`;
}

/** Tokens of an assistant message's tool-call arguments, which elide replaces with a stub. */
export function argumentTokens(message: AssistantMessage): number {
  const calls = message.content.filter((block) => block.type === "toolCall");
  return calls.reduce((sum, block) => sum + estimateTokens({ ...message, content: [block] }), 0);
}

/**
 * An assistant message whose tool calls become one note, where the first call was. Text and
 * thinking stay, so signed thinking still replays; the calls' results are omitted with them, so
 * every remaining result still answers a call.
 */
function foldedAssistant(message: AssistantMessage, note: string): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  for (const block of message.content) {
    if (block.type !== "toolCall") content.push(block);
    else if (!content.some((kept) => kept.type === "text" && kept.text === note))
      content.push({ type: "text", text: note });
  }
  return { ...message, content };
}

function stubbed(message: AgentMessage, stub: string): AgentMessage {
  if (message.role === "toolResult") return { ...message, content: [{ type: "text", text: stub }] };
  return message.role === "assistant" ? foldedAssistant(message, stub) : message;
}

/** Tokens of an entry after elision replaces its result or tool-call arguments with a stub. */
export function stubTokens(item: ContextItem, stub: string): number {
  return item.messages.reduce((sum, message) => sum + estimateTokens(stubbed(message, stub)), 0);
}

function elisionProblem(item: ContextItem, stubSize: number, size: number): string | undefined {
  if (item.protectedReason) return `${item.id} is protected: ${item.protectedReason}`;
  if (item.role === "assistant") {
    if (item.toolCallIds.length === 0) {
      return `${item.id} is an assistant entry without tool calls; elide shrinks tool results and tool-call arguments, and session.summarize replaces assistant turns`;
    }
  } else if (item.role !== "toolResult") {
    // The remaining roles (user, note, notice, custom, bash, summary) take "a".
    return `${item.id} is a ${item.role} entry; elide accepts tool results and assistant entries with tool calls, and session.summarize replaces assistant turns`;
  }
  if (item.state === "elided") return `${item.id} is already elided`;
  // A summary carrier or another edited entry already stands in for its original.
  if (item.state !== "original")
    return `${item.id} is ${item.state}; elide edits only original entries`;
  return stubSize >= size ? `${item.id} is no larger than its elision stub` : undefined;
}

function stubFor(view: ContextView, item: ContextItem, reason?: string): string {
  return item.role === "assistant"
    ? callNote(view, item, reason)
    : elisionStub(item.id, item.tokens, reason);
}

function replacement(item: ContextItem, stub: string): EditableContent {
  if (item.role !== "assistant") return stub;
  return foldedAssistant(item.messages[0] as AssistantMessage, stub).content;
}

export function planElide(
  view: ContextView,
  ids: readonly string[],
  reason: string | undefined,
  basis: CacheBasis,
): PlannedEdit {
  const problems = new PlanProblems();
  // Eliding a call folds its results into the call's note, so a targeted result whose call is
  // also targeted needs no stub of its own.
  const folded = new Map<string, ContextItem[]>();
  for (const id of ids) {
    const item = view.byId.get(id);
    if (item?.role === "assistant") folded.set(id, callResults(view, item));
  }
  const foldedIds = new Set([...folded.values()].flat().map((result) => result.id));
  const stubs: Array<{ item: ContextItem; stub: string; tokens: number; results: ContextItem[] }> =
    [];
  for (const id of ids) {
    if (foldedIds.has(id)) continue;
    const item = view.byId.get(id);
    if (!item) {
      problems.add(describeMissing(view, id));
      continue;
    }
    const results = folded.get(id) ?? [];
    const stub = stubFor(view, item, reason);
    const tokens = stubTokens(item, stub);
    const size = item.tokens + results.reduce((sum, result) => sum + result.tokens, 0);
    const problem = elisionProblem(item, tokens, size);
    if (problem) problems.add(problem);
    else stubs.push({ item, stub, tokens, results });
  }
  const retry =
    stubs.length > 0
      ? `These can be elided: ${JSON.stringify(stubs.map(({ item }) => item.id))}`
      : undefined;
  problems.throwIfAny("elide", retry);
  const tokensFreed = stubs.reduce(
    (sum, { item, tokens, results }) =>
      sum + item.tokens - tokens + results.reduce((total, result) => total + result.tokens, 0),
    0,
  );
  const targets = [
    ...new Set([...ids, ...stubs.flatMap(({ results }) => results.map((result) => result.id))]),
  ];
  const reprefillTokens = reprefillAfter(view, targets, tokensFreed, basis);
  const calls = stubs.filter(({ item }) => item.role === "assistant").length;
  const drafts: PlannedEdit["drafts"] = [];
  for (const { item, stub, results } of stubs) {
    drafts.push({
      type: "context_edit",
      targetId: item.id,
      replacement: { content: replacement(item, stub) },
    });
    // The call's results go with it, so no remaining result lacks its call.
    for (const result of results)
      drafts.push({ type: "context_edit", targetId: result.id, replacement: null });
  }
  return {
    operation: "elide",
    targets,
    drafts,
    records: [
      {
        operation: "elide",
        targets,
        ...(calls > 0 ? { toolCallEntries: calls } : {}),
        ...(reason ? { reason } : {}),
        tokensFreed,
        reprefillTokens,
      },
    ],
    ...(calls > 0 ? { receipt: { toolCallEntries: calls } } : {}),
    tokensFreed,
    reprefillTokens,
  };
}
