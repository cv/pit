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

/** A range must be completed agent work whose tool calls and results stay together. */
function checkRange(view: ContextView, range: readonly ContextItem[]): void {
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
  problems.throwIfAny("summarize");
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
