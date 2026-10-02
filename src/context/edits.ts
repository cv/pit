import { estimateTokens } from "@earendil-works/pi-coding-agent";

import {
  describeMissing,
  formatTokens,
  type PlannedEdit,
  PlanProblems,
  reprefillAfter,
} from "./planning.js";
import {
  type AgentMessage,
  type AssistantMessage,
  type ContextItem,
  type ContextView,
  ELIDED_ARGUMENTS_PREFIX,
  ELIDED_PREFIX,
  type EditableContent,
} from "./view.js";

export const MAX_REASON_CHARS = 200;

export function elisionStub(id: string, tokens: number, reason?: string): string {
  const because = reason ? ` · reason: ${reason}` : "";
  return `${ELIDED_PREFIX} · ~${formatTokens(tokens)} tokens${because} · original: session.inspectEntry("${id}")]`;
}

/**
 * The arguments that replace an elided tool call's. It reads as an omission, not as code, so a
 * model does not mistake it for a program that ran; recovery probes for #222 showed both.
 */
export function argumentStub(id: string, tokens: number, reason?: string): string {
  const because = reason ? ` · reason: ${reason}` : "";
  return `${ELIDED_ARGUMENTS_PREFIX}; this is not the original call · ~${formatTokens(tokens)} tokens${because} · original: session.inspectEntry("${id}")]`;
}

function argumentTokens(message: AssistantMessage): number {
  const calls = message.content.filter((block) => block.type === "toolCall");
  return calls.reduce((sum, block) => sum + estimateTokens({ ...message, content: [block] }), 0);
}

/**
 * An assistant message with each tool call's arguments replaced. Text, thinking, and each call's
 * ID and name stay, so tool results still answer their calls and signed thinking replays.
 */
function stubbedAssistant(message: AssistantMessage, stub: string): AssistantMessage {
  return {
    ...message,
    content: message.content.map((block) =>
      block.type === "toolCall" ? { ...block, arguments: { elided: stub } } : block,
    ),
  };
}

function stubbed(message: AgentMessage, stub: string): AgentMessage {
  if (message.role === "toolResult") return { ...message, content: [{ type: "text", text: stub }] };
  return message.role === "assistant" ? stubbedAssistant(message, stub) : message;
}

/** Tokens of an entry after elision replaces its result or tool-call arguments with a stub. */
export function stubTokens(item: ContextItem, stub: string): number {
  return item.messages.reduce((sum, message) => sum + estimateTokens(stubbed(message, stub)), 0);
}

function elisionProblem(item: ContextItem, stubSize: number): string | undefined {
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
  return stubSize >= item.tokens ? `${item.id} is no larger than its elision stub` : undefined;
}

function stubFor(item: ContextItem, reason?: string): string {
  if (item.role !== "assistant") return elisionStub(item.id, item.tokens, reason);
  const tokens = argumentTokens(item.messages[0] as AssistantMessage);
  return argumentStub(item.id, tokens, reason);
}

function replacement(item: ContextItem, stub: string): EditableContent {
  if (item.role !== "assistant") return stub;
  return stubbedAssistant(item.messages[0] as AssistantMessage, stub).content;
}

export function planElide(view: ContextView, ids: readonly string[], reason?: string): PlannedEdit {
  const problems = new PlanProblems();
  const stubs: Array<{ item: ContextItem; stub: string; tokens: number }> = [];
  for (const id of ids) {
    const item = view.byId.get(id);
    if (!item) {
      problems.add(describeMissing(view, id));
      continue;
    }
    const stub = stubFor(item, reason);
    const tokens = stubTokens(item, stub);
    const problem = elisionProblem(item, tokens);
    if (problem) problems.add(problem);
    else stubs.push({ item, stub, tokens });
  }
  const retry =
    stubs.length > 0
      ? `These can be elided: ${JSON.stringify(stubs.map(({ item }) => item.id))}`
      : undefined;
  problems.throwIfAny("elide", retry);
  const tokensFreed = stubs.reduce((sum, { item, tokens }) => sum + item.tokens - tokens, 0);
  const reprefillTokens = reprefillAfter(view, ids, tokensFreed);
  const calls = stubs.filter(({ item }) => item.role === "assistant").length;
  return {
    operation: "elide",
    targets: [...ids],
    drafts: stubs.map(({ item, stub }) => ({
      type: "context_edit",
      targetId: item.id,
      replacement: { content: replacement(item, stub) },
    })),
    records: [
      {
        operation: "elide",
        targets: [...ids],
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
