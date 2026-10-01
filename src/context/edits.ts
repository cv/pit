import { estimateTokens } from "@earendil-works/pi-coding-agent";

import {
  describeMissing,
  formatTokens,
  type PlannedEdit,
  PlanProblems,
  reprefillAfter,
} from "./planning.js";
import { type AgentMessage, type ContextItem, type ContextView, ELIDED_PREFIX } from "./view.js";

export const MAX_REASON_CHARS = 200;

export function elisionStub(id: string, tokens: number, reason?: string): string {
  const because = reason ? ` · reason: ${reason}` : "";
  return `${ELIDED_PREFIX} · ~${formatTokens(tokens)} tokens${because} · original: session.inspectEntry("${id}")]`;
}

function stubbed(message: AgentMessage, stub: string): AgentMessage {
  return message.role === "toolResult"
    ? { ...message, content: [{ type: "text", text: stub }] }
    : message;
}

/** Tokens of a tool result after its content becomes an elision stub. */
export function stubTokens(item: ContextItem, stub: string): number {
  return item.messages.reduce((sum, message) => sum + estimateTokens(stubbed(message, stub)), 0);
}

function elisionProblem(item: ContextItem, stubSize: number): string | undefined {
  if (item.protectedReason) return `${item.id} is protected: ${item.protectedReason}`;
  if (item.role !== "toolResult") {
    const article = /^[aeiou]/.test(item.role) ? "an" : "a";
    return `${item.id} is ${article} ${item.role} entry; elide accepts tool results, and session.summarize replaces assistant turns`;
  }
  if (item.state === "elided") return `${item.id} is already elided`;
  return stubSize >= item.tokens ? `${item.id} is no larger than its elision stub` : undefined;
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
    const stub = elisionStub(id, item.tokens, reason);
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
  return {
    operation: "elide",
    targets: [...ids],
    drafts: stubs.map(({ item, stub }) => ({
      type: "context_edit",
      targetId: item.id,
      replacement: { content: stub },
    })),
    records: [
      {
        operation: "elide",
        targets: [...ids],
        ...(reason ? { reason } : {}),
        tokensFreed,
        reprefillTokens,
      },
    ],
    tokensFreed,
    reprefillTokens,
  };
}
