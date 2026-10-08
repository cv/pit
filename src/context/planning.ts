import { estimateTokens, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";

import type { CacheMode, ContextOperation, ContextView, ProvenanceOperation } from "./view.js";

/** A validated context edit before the queue assigns it to a tool call. */
export interface PlannedEdit {
  operation: ContextOperation;
  targets: string[];
  drafts: SessionBoundaryDraft[];
  records: Array<Omit<ProvenanceOperation, "toolCallId" | "cacheMode">>;
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
 * How a model's provider caches the prompt, from the API Pi uses for it. Pi marks cache
 * breakpoints for Anthropic Messages, Bedrock Converse, and OpenAI-compatible APIs with
 * Anthropic-style `cache_control`; OpenAI's other APIs reuse the longest unchanged prefix.
 */
export function cacheModeOf(
  model: { api: string; provider: string; id: string; compat?: unknown } | undefined,
): CacheMode {
  switch (model?.api) {
    case "anthropic-messages":
    case "bedrock-converse-stream":
      return "breakpoints";
    case "openai-responses":
    case "azure-openai-responses":
    case "openai-codex-responses":
      return "prefix";
    case "openai-completions": {
      // Mirrors pi-ai's detection: OpenRouter's Anthropic models use cache_control by default.
      const format =
        (model.compat as { cacheControlFormat?: string } | undefined)?.cacheControlFormat ??
        (model.provider === "openrouter" && model.id.startsWith("anthropic/") ? "anthropic" : "");
      return format === "anthropic" ? "breakpoints" : "prefix";
    }
    default:
      return "unknown";
  }
}

/**
 * What a re-prefill estimate rests on. Pi's per-message estimates count four characters per
 * token and only the visible text of thinking blocks, so they undercount the conversation a
 * provider caches; Pi's reported context usage, from the last response, does not.
 */
export interface CacheBasis {
  mode: CacheMode;
  /** Tokens after the system prompt: Pi's measured usage when known, never below Pit's estimate. */
  conversationTokens: number;
}

export function cacheBasis(
  model: Parameters<typeof cacheModeOf>[0],
  view: ContextView,
  usageTokens: number | null | undefined,
): CacheBasis {
  const measured = typeof usageTokens === "number" ? usageTokens - view.systemTokens : 0;
  return { mode: cacheModeOf(model), conversationTokens: Math.max(view.tokens, measured) };
}

/** What a re-prefill estimate covers, for receipts and transcript rows. */
export const CACHE_BASIS: Record<CacheMode, string> = {
  breakpoints: "whole conversation (breakpoint cache)",
  prefix: "from the edited entry (prefix cache)",
  unknown: "upper bound (unknown cache)",
};

/**
 * Estimated tokens a provider prefills again after the edit. A prefix cache keeps everything
 * before the earliest changed model-visible entry, so it re-prefills from there to the leaf. A
 * breakpoint cache keeps only the tools and system prompt once an earlier entry changes, so it
 * re-prefills the whole post-edit conversation; an unknown provider gets the same upper bound.
 */
export function reprefillAfter(
  view: ContextView,
  targets: Iterable<string>,
  tokensFreed: number,
  basis: CacheBasis,
): number {
  const changed = new Set(targets);
  const earliest = view.items.findIndex((item) => changed.has(item.id));
  /* v8 ignore next -- every edit changes at least one model-visible entry. */
  if (earliest < 0) return 0;
  if (basis.mode === "prefix") {
    const suffix = view.items.slice(earliest).reduce((sum, item) => sum + item.tokens, 0);
    return Math.max(0, suffix - tokensFreed);
  }
  // The conversation is measured but the freed tokens are Pit's estimates, which undercount
  // alike, so scale them to the measurement before subtracting.
  const scale = view.tokens > 0 ? basis.conversationTokens / view.tokens : 1;
  return Math.max(0, Math.round(basis.conversationTokens - tokensFreed * scale));
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
