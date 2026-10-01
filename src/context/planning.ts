import { estimateTokens, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";

import type { ContextOperation, ContextView, ProvenanceOperation } from "./view.js";

/** A validated context edit before the queue assigns it to a tool call. */
export interface PlannedEdit {
  operation: ContextOperation;
  targets: string[];
  drafts: SessionBoundaryDraft[];
  records: Array<Omit<ProvenanceOperation, "toolCallId">>;
  tokensFreed: number;
  reprefillTokens: number;
  /** Operation-specific receipt fields. */
  receipt?: Record<string, string | number>;
}

export const MAX_EDIT_TARGETS = 200;

export function formatTokens(tokens: number): string {
  const scaled = (value: number, unit: string) => `${value.toFixed(1).replace(/\.0$/, "")}${unit}`;
  if (tokens < 1_000) return String(tokens);
  return tokens < 1_000_000 ? scaled(tokens / 1_000, "K") : scaled(tokens / 1_000_000, "M");
}

/** Pi's estimate for text sent as one user-side text block. */
export function textTokens(text: string): number {
  return estimateTokens({ role: "user", content: text, timestamp: 0 });
}

/**
 * Estimated tokens a provider prefills again after the edit: the post-edit context from the
 * earliest changed model-visible entry to the leaf.
 */
export function reprefillAfter(
  view: ContextView,
  targets: Iterable<string>,
  tokensFreed: number,
): number {
  const changed = new Set(targets);
  const earliest = view.items.findIndex((item) => changed.has(item.id));
  /* v8 ignore next -- every edit changes at least one model-visible entry. */
  if (earliest < 0) return 0;
  const suffix = view.items.slice(earliest).reduce((sum, item) => sum + item.tokens, 0);
  return Math.max(0, suffix - tokensFreed);
}

/** Why an ID has no model-visible contribution. */
export function describeMissing(view: ContextView, id: string): string {
  if (!view.branchIds.has(id)) return `${id} is not on the active branch`;
  return view.contextIds.has(id) ? `${id} is not model-visible` : `${id} was compacted`;
}

/** Collects every validation problem so one error explains the whole rejected call. */
export class PlanProblems {
  readonly #problems: string[] = [];

  get size(): number {
    return this.#problems.length;
  }

  add(problem: string): void {
    this.#problems.push(problem);
  }

  /** The retry hint, when given, follows the problems so a model can correct the call at once. */
  throwIfAny(action: string, retry?: string): void {
    if (this.#problems.length === 0) return;
    const shown = this.#problems.slice(0, 5).join("; ");
    const more = this.#problems.length > 5 ? `; and ${this.#problems.length - 5} more` : "";
    throw new Error(`Cannot ${action}: ${shown}${more}${retry ? `. ${retry}` : ""}`);
  }
}
