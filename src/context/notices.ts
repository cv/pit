import type { ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";

import { formatTokens } from "./planning.js";
import { NOTICE_TYPE } from "./view.js";

/** Context-usage percentages that each earn one notice until a compaction removes it. */
export const NOTICE_LEVELS = [75, 50] as const;

/**
 * Context tokens that earn a notice before 50% in a large window: every request already resends
 * this much, which is costly even when the window has room.
 */
export const NOTICE_TOKENS = 200_000;

export interface NoticeDetails {
  /** The whole percentage of the window at the threshold that fired. */
  level: number;
  percent: number;
  tokens: number;
  contextWindow: number;
  /** The threshold that fired, such as "50%" or "200K", and its context tokens. */
  threshold: string;
  thresholdTokens: number;
}

interface Threshold {
  label: string;
  tokens: number;
  level: number;
}

/** Thresholds in descending token order; NOTICE_TOKENS only where it precedes 50%. */
function thresholds(contextWindow: number): Threshold[] {
  const levels = NOTICE_LEVELS.map((level) => ({
    label: `${level}%`,
    tokens: (level / 100) * contextWindow,
    level,
  }));
  if (NOTICE_TOKENS >= (50 / 100) * contextWindow) return levels;
  return [
    ...levels,
    {
      label: formatTokens(NOTICE_TOKENS),
      tokens: NOTICE_TOKENS,
      level: Math.floor((100 * NOTICE_TOKENS) / contextWindow),
    },
  ];
}

export function noticeText(details: NoticeDetails): string {
  return `[Pit] Context is ${details.percent}% full (~${formatTokens(details.tokens)} of ${formatTokens(details.contextWindow)} tokens), and every request resends it. Use session.outline() to pick absorbed tool results and applied edit calls (entries with edits) to elide and finished turns to summarize, together in one call, and keep task state in session.setNote(). An edit pays back after about 15 × its estimatedReprefillTokens ÷ estimatedTokensFreed later requests.`;
}

/** The highest threshold, in tokens, among notices still visible on the active branch. */
function visibleThreshold(ctx: ExtensionContext): number {
  let highest = 0;
  for (const { sourceEntry, messages } of ctx.sessionManager.buildSessionProjection().entries) {
    if (sourceEntry.type !== "custom_message" || sourceEntry.customType !== NOTICE_TYPE) continue;
    if (messages.length === 0) continue;
    const details = sourceEntry.details as Partial<NoticeDetails> | undefined;
    highest = Math.max(highest, details?.thresholdTokens ?? 0);
  }
  return highest;
}

/**
 * A notice when context usage first crosses a threshold. Earlier notices stay: they are small,
 * and omitting one mid-context would re-prefill everything after it.
 */
export function pressureNotice(ctx: ExtensionContext): SessionBoundaryDraft[] {
  const usage = ctx.getContextUsage();
  if (typeof usage?.percent !== "number" || typeof usage.tokens !== "number") return [];
  const { tokens, contextWindow } = usage;
  const crossed = thresholds(contextWindow).find((threshold) => tokens >= threshold.tokens);
  if (crossed === undefined || crossed.tokens <= visibleThreshold(ctx)) return [];
  const details: NoticeDetails = {
    level: crossed.level,
    percent: Math.round(usage.percent),
    tokens,
    contextWindow,
    threshold: crossed.label,
    thresholdTokens: crossed.tokens,
  };
  return [
    {
      type: "custom_message",
      customType: NOTICE_TYPE,
      content: noticeText(details),
      display: true,
      details,
    },
  ];
}
