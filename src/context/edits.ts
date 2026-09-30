import { estimateTokens, type SessionEntry } from "@earendil-works/pi-coding-agent";

import { entryText } from "./inspect.js";
import {
  describeMissing,
  formatTokens,
  type PlannedEdit,
  PlanProblems,
  reprefillAfter,
  textTokens,
} from "./planning.js";
import {
  type AgentMessage,
  type ContextItem,
  type ContextView,
  ELIDED_PREFIX,
  originalContent,
  type SessionReader,
} from "./view.js";

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
  problems.throwIfAny("elide");
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

interface RestoreGroup {
  targets: readonly string[];
  carrier?: string;
}

function restoreGroup(view: ContextView, id: string): RestoreGroup | string {
  const carrier = view.summaries.has(id) ? id : view.summaryOf.get(id);
  const covers = carrier === undefined ? undefined : view.summaries.get(carrier);
  if (carrier !== undefined && covers && view.byId.get(carrier)?.state === "summarized") {
    return { targets: covers, carrier };
  }
  const item = view.byId.get(id);
  if (item?.state === "elided") return { targets: [id] };
  if (item?.state === "original") return `${id} is not edited`;
  if (item) return `${id} was edited outside Pit`;
  return view.contextIds.has(id) && view.branchIds.has(id)
    ? `${id} was omitted outside Pit`
    : describeMissing(view, id);
}

function originalTokens(entry: SessionEntry): number {
  if (entry.type === "message") return estimateTokens(entry.message);
  return textTokens(entryText(entry) as string);
}

/** Resolves each ID to what restoring it means; a summarized range absorbs its single entries. */
function restoreGroups(view: ContextView, ids: readonly string[]): RestoreGroup[] {
  const problems = new PlanProblems();
  const groups: RestoreGroup[] = [];
  for (const id of ids) {
    const group = restoreGroup(view, id);
    if (typeof group === "string") problems.add(group);
    else if (
      group.carrier === undefined ||
      !groups.some((existing) => existing.carrier === group.carrier)
    ) {
      groups.push(group);
    }
  }
  problems.throwIfAny("restore");
  const ranged = new Set(groups.flatMap((group) => (group.carrier ? group.targets : [])));
  return groups.filter((group) => group.carrier || !ranged.has(group.targets[0] as string));
}

export function planRestore(
  view: ContextView,
  session: SessionReader,
  ids: readonly string[],
): PlannedEdit {
  const groups = restoreGroups(view, ids);
  const drafts: PlannedEdit["drafts"] = [];
  const added = new Map<string, number>();
  let restoredChars = 0;
  for (const target of new Set(groups.flatMap((group) => group.targets))) {
    // Restorable IDs are elided results or entries a summarize record on this branch covers.
    const entry = session.getEntry(target) as SessionEntry;
    drafts.push({
      type: "context_edit",
      targetId: target,
      replacement: { content: originalContent(entry) },
    });
    restoredChars += (entryText(entry) as string).length;
    added.set(target, originalTokens(entry) - (view.byId.get(target)?.tokens ?? 0));
  }
  const targets = [...added.keys()];
  const total = [...added.values()].reduce((sum, tokens) => sum + tokens, 0);
  const reprefillTokens = reprefillAfter(view, targets, -total);
  return {
    operation: "restore",
    targets,
    drafts,
    records: groups.map((group) => {
      const tokensFreed = -group.targets.reduce((sum, id) => sum + (added.get(id) as number), 0);
      const operation = { operation: "restore" as const, targets: group.targets.slice() };
      return group.carrier === undefined
        ? Object.assign(operation, { tokensFreed, reprefillTokens })
        : Object.assign(operation, { carrier: group.carrier, tokensFreed, reprefillTokens });
    }),
    tokensFreed: -total,
    reprefillTokens,
    receipt: { restoredChars },
  };
}
