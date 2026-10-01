import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateTokens,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";

import { elisionStub, stubTokens } from "./edits.js";
import {
  describeMissing,
  formatTokens,
  type PlannedEdit,
  PlanProblems,
  reprefillAfter,
  textTokens,
} from "./planning.js";
import {
  type AssistantMessage,
  type ContextItem,
  type ContextView,
  SUMMARY_PREFIX,
} from "./view.js";

type Settings = ReturnType<ExtensionAPI["getSettings"]>;

/**
 * The largest model-written summary: Pi's own compaction-summary budget,
 * min(0.8 × reserveTokens, the model's output limit).
 */
export function summaryTokenCap(
  settings: Settings | undefined,
  model: ExtensionContext["model"],
): number {
  const key = model ? `${model.provider}/${model.id}` : undefined;
  const compaction = settings?.compaction;
  const reserveTokens =
    (key === undefined ? undefined : compaction?.modelOverrides?.[key]?.reserveTokens) ??
    compaction?.reserveTokens ??
    DEFAULT_COMPACTION_SETTINGS.reserveTokens;
  const outputLimit = model && model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY;
  return Math.min(Math.floor(0.8 * reserveTokens), outputLimit);
}

function rangeOf(view: ContextView, from: string, to: string): ContextItem[] {
  const start = view.items.findIndex((item) => item.id === from);
  const end = view.items.findIndex((item) => item.id === to);
  const problems = new PlanProblems();
  if (start < 0) problems.add(describeMissing(view, from));
  if (end < 0) problems.add(describeMissing(view, to));
  if (start >= 0 && end >= 0 && start > end) problems.add(`${from} comes after ${to}`);
  problems.throwIfAny("summarize");
  return view.items.slice(start, end + 1);
}

/** Why a range is not completed agent work whose tool calls and results stay together. */
function rangeProblems(view: ContextView, range: readonly ContextItem[]): PlanProblems {
  const problems = new PlanProblems();
  const [first] = range;
  if (first && first.role !== "assistant") {
    problems.add(`a range starts at an assistant entry; ${first.id} is a ${first.role} entry`);
  }
  const inRange = new Set(range.map((item) => item.id));
  const calls = new Set(
    range.flatMap((item) => (item.role === "assistant" ? item.toolCallIds : [])),
  );
  for (const item of range) {
    if (item.protectedReason) problems.add(`${item.id} is protected: ${item.protectedReason}`);
    else if (item.role === "toolResult" && !calls.has(item.toolCallIds[0] as string)) {
      problems.add(`${item.id} answers a tool call outside the range`);
    }
  }
  for (const item of view.items) {
    if (
      item.role === "toolResult" &&
      !inRange.has(item.id) &&
      calls.has(item.toolCallIds[0] as string)
    ) {
      problems.add(`${item.id} answers a tool call in the range; end the range at or after it`);
    }
  }
  return problems;
}

/**
 * The nearest valid range around a rejected one: starting at the assistant turn the requested
 * start belongs to, or the next one, and ending once every tool call in it has its result. None
 * when the repair would cross a protected entry.
 */
function repairRange(view: ContextView, start: number, end: number): [string, string] | undefined {
  const { items } = view;
  const first = items[start] as ContextItem;
  let from = start;
  if (first.role === "toolResult") {
    const call = first.toolCallIds[0];
    const caller = items.findIndex(
      (item) => item.role === "assistant" && item.toolCallIds.includes(call as string),
    );
    if (caller >= 0 && caller < start) from = caller;
  }
  while (from <= end && items[from]?.role !== "assistant") from++;
  if (from > end) return undefined;
  let to = end;
  for (let index = from; index <= to && index < items.length; index++) {
    const item = items[index] as ContextItem;
    if (item.role !== "assistant") continue;
    for (const call of item.toolCallIds) {
      const answer = items.findIndex(
        (candidate) => candidate.role === "toolResult" && candidate.toolCallIds[0] === call,
      );
      if (answer > to) to = answer;
    }
  }
  if (from === start && to === end) return undefined;
  const repaired = items.slice(from, to + 1);
  if (rangeProblems(view, repaired).size > 0) return undefined;
  return [(items[from] as ContextItem).id, (items[to] as ContextItem).id];
}

function checkRange(view: ContextView, range: readonly ContextItem[]): void {
  const problems = rangeProblems(view, range);
  if (problems.size === 0) return;
  const start = view.items.indexOf(range[0] as ContextItem);
  const repaired = repairRange(view, start, start + range.length - 1);
  const retry = repaired
    ? `Try summarize({ from: ${JSON.stringify(repaired[0])}, to: ${JSON.stringify(repaired[1])} })`
    : undefined;
  problems.throwIfAny("summarize", retry);
}

function carrierMessage(item: ContextItem, text: string): AssistantMessage {
  const message = item.messages[0] as AssistantMessage;
  const calls = message.content.filter((block) => block.type === "toolCall");
  return { ...message, content: [{ type: "text", text }, ...calls] };
}

export function planSummarize(
  view: ContextView,
  input: { from: string; to: string; summary: string; capTokens: number },
): PlannedEdit {
  const summary = input.summary.trim();
  if (summary === "") throw new Error("Cannot summarize: the summary is empty");
  const range = rangeOf(view, input.from, input.to);
  checkRange(view, range);
  const summaryTokens = textTokens(summary);
  if (summaryTokens > input.capTokens) {
    throw new Error(
      `Cannot summarize: the summary is ~${formatTokens(summaryTokens)} tokens; the limit is ~${formatTokens(input.capTokens)}, Pi's compaction-summary budget`,
    );
  }
  const carrier = range[0] as ContextItem;
  // Earlier summaries inside the range fold into this one, so inspectEntry lists their entries.
  const covers = [
    ...new Set(range.flatMap((item) => [item.id, ...(view.summaries.get(item.id) ?? [])])),
  ];
  const header = `${SUMMARY_PREFIX}${range.length} entries from ${input.from} to ${input.to} · originals: session.inspectEntry(id)]`;
  const message = carrierMessage(carrier, `${header}\n\n${summary}`);
  const drafts: SessionBoundaryDraft[] = [
    { type: "context_edit", targetId: carrier.id, replacement: { content: message.content } },
  ];
  let tokensAfter = estimateTokens(message);
  for (const item of range.slice(1)) {
    const answersCarrier =
      item.role === "toolResult" && carrier.toolCallIds.includes(item.toolCallIds[0] as string);
    const stub = answersCarrier ? elisionStub(item.id, item.tokens, "summarized") : undefined;
    if (stub) tokensAfter += stubTokens(item, stub);
    drafts.push({
      type: "context_edit",
      targetId: item.id,
      replacement: stub === undefined ? null : { content: stub },
    });
  }
  const tokensBefore = range.reduce((sum, item) => sum + item.tokens, 0);
  if (tokensAfter >= tokensBefore) {
    throw new Error(
      `Cannot summarize: the summary and the tool calls it keeps (~${formatTokens(tokensAfter)} tokens) are not smaller than the ${range.length} entries they replace (~${formatTokens(tokensBefore)} tokens)`,
    );
  }
  const tokensFreed = tokensBefore - tokensAfter;
  const reprefillTokens = reprefillAfter(view, [carrier.id], tokensFreed);
  return {
    operation: "summarize",
    targets: covers,
    drafts,
    records: [
      {
        operation: "summarize",
        targets: covers,
        carrier: carrier.id,
        covers,
        tokensFreed,
        reprefillTokens,
      },
    ],
    tokensFreed,
    reprefillTokens,
    receipt: { summarizedEntries: range.length, summaryTokens },
  };
}
