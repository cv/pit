import { digestTypeScriptCall, type PresentedToolResult, toolOutcome } from "../present.js";
import { type CollapsedCall, collapsedCallNote, type PlannedEdit } from "./edits.js";
import {
  type AssistantMessage,
  type ContextEdit,
  type ContextItem,
  type ContextView,
  messageTokens,
} from "./view.js";

/** When Pit collapses finished runs' tool calls, resolved from `PitDurableOptions.collapse`. */
export interface CollapseSettings {
  /** Runs kept whole, counting the run that just answered. */
  keepRuns: number;
  /** The conversation's messages, without the system prompt, must exceed this many tokens. */
  minTokens: number;
}

export type CollapseOption = { keepRuns?: number; minTokens?: number } | false;

export const DEFAULT_COLLAPSE: Readonly<CollapseSettings> = { keepRuns: 1, minTokens: 32_000 };

export function resolveCollapse(option: CollapseOption | undefined): CollapseSettings | undefined {
  if (option === false) return undefined;
  const keepRuns = option?.keepRuns ?? DEFAULT_COLLAPSE.keepRuns;
  const minTokens = option?.minTokens ?? DEFAULT_COLLAPSE.minTokens;
  if (!Number.isSafeInteger(keepRuns) || keepRuns < 1) {
    throw new Error("collapse.keepRuns must be a positive integer");
  }
  if (!Number.isSafeInteger(minTokens) || minTokens < 0) {
    throw new Error("collapse.minTokens must be a non-negative integer");
  }
  return { keepRuns, minTokens };
}

const INPUTS = new Set<ContextItem["role"]>(["user", "custom"]);

/**
 * The finished runs still in the context, oldest first: everything before `first`, the current
 * run's first entry. A run starts at the user or host messages that follow another run's entries.
 */
function finishedRuns(view: ContextView, first: number): ContextItem[][] {
  const runs: ContextItem[][] = [];
  let afterInput = false;
  for (const item of view.items) {
    if (Number(item.id) >= first) continue;
    const input = INPUTS.has(item.role);
    if (runs.length === 0 || (input && !afterInput)) runs.push([]);
    (runs.at(-1) as ContextItem[]).push(item);
    afterInput = input;
  }
  return runs;
}

/** The results of a tool-calling entry that may collapse with them; none when it may not. */
function collapsibleResults(view: ContextView, item: ContextItem): ContextItem[] | undefined {
  if (item.role !== "assistant" || item.toolCallIds.length === 0) return undefined;
  const untouched = (entry: ContextItem) =>
    entry.state === "original" && !entry.protectedReason && !view.pending.has(entry.id);
  if (!untouched(item)) return undefined;
  const results = item.toolCallIds.flatMap((id) => {
    const result = view.results.get(id);
    return result ? [result] : [];
  });
  return results.every(untouched) ? results : undefined;
}

function describe(
  call: { name: string; arguments: unknown },
  result: ContextItem | undefined,
): CollapsedCall {
  const message = result?.messages[0] as PresentedToolResult | undefined;
  if (call.name === "typescript") {
    const { title, functions, outcome } = digestTypeScriptCall(call.arguments, message);
    return { tool: call.name, title, functions, outcome };
  }
  return { tool: call.name, functions: [], outcome: toolOutcome(message) };
}

/** The assistant entry with its text and thinking kept and its tool calls replaced by `note`. */
function collapsedMessage(message: AssistantMessage, note: string): AssistantMessage {
  const kept = message.content.filter((block) => block.type !== "toolCall");
  // No tool calls remain, so the turn reads as one that stopped.
  return { ...message, content: [...kept, { type: "text", text: note }], stopReason: "stop" };
}

/**
 * Collapse the tool calls of finished runs older than the newest `keepRuns` into one line each,
 * with their results omitted. Entries already rewritten, staged for a rewrite, or protected stay
 * as they are, and so does an entry its line would not make smaller. Nothing collapses while the
 * conversation's messages stay within `minTokens`.
 */
export function planCollapse(
  view: ContextView,
  first: number,
  settings: CollapseSettings,
): PlannedEdit | undefined {
  if (view.tokens - view.systemTokens <= settings.minTokens) return undefined;
  const runs = finishedRuns(view, first);
  // The run that just answered is one of the `keepRuns` kept whole, and `runs` excludes it.
  const older = runs.slice(0, Math.max(0, runs.length - (settings.keepRuns - 1)));
  const edits: ContextEdit[] = [];
  const targets: string[] = [];
  const covers: string[] = [];
  let tokensFreed = 0;
  for (const item of older.flat()) {
    const results = collapsibleResults(view, item);
    if (!results) continue;
    const message = item.messages[0] as AssistantMessage;
    const calls = message.content.flatMap((block) => (block.type === "toolCall" ? [block] : []));
    const ids = [item.id, ...results.map((result) => result.id)];
    const tokens = [item, ...results].reduce((sum, entry) => sum + entry.tokens, 0);
    const note = collapsedCallNote(
      calls.map((call) => describe(call, view.results.get(call.id))),
      tokens,
      ids,
    );
    const replacement = collapsedMessage(message, note);
    const kept = messageTokens(replacement);
    if (kept >= tokens) continue;
    edits.push({ target: item.entry.id, action: "replace", messages: [replacement] });
    for (const result of results) edits.push({ target: result.entry.id, action: "omit" });
    targets.push(item.id);
    covers.push(...ids);
    tokensFreed += tokens - kept;
  }
  if (edits.length === 0) return undefined;
  return { edits, provenance: { operation: "collapse", targets, covers, tokensFreed } };
}
