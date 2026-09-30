import type { ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";

import { formatTokens } from "./planning.js";
import { NOTICE_TYPE } from "./view.js";

/** Context-usage percentages that each earn one notice until a compaction removes it. */
export const NOTICE_LEVELS = [75, 50] as const;

export interface NoticeDetails {
  level: number;
  percent: number;
  tokens: number;
  contextWindow: number;
}

export function noticeText(details: NoticeDetails): string {
  return `[Pit] Context is ${details.percent}% full (~${formatTokens(details.tokens)} of ${formatTokens(details.contextWindow)} tokens). Use session.outline() to find stale tool results for session.elide() or finished turns for session.summarize(), and keep task state in session.setNote().`;
}

/** The highest notice level still visible to the model on the active branch. */
function visibleLevel(ctx: ExtensionContext): number {
  let level = 0;
  for (const { sourceEntry, messages } of ctx.sessionManager.buildSessionProjection().entries) {
    if (sourceEntry.type !== "custom_message" || sourceEntry.customType !== NOTICE_TYPE) continue;
    const details = sourceEntry.details as Partial<NoticeDetails> | undefined;
    if (messages.length > 0 && typeof details?.level === "number") {
      level = Math.max(level, details.level);
    }
  }
  return level;
}

/**
 * A notice when context usage first crosses a level. Earlier notices stay: they are small,
 * and omitting one mid-context would re-prefill everything after it.
 */
export function pressureNotice(ctx: ExtensionContext): SessionBoundaryDraft[] {
  const usage = ctx.getContextUsage();
  if (typeof usage?.percent !== "number" || typeof usage.tokens !== "number") return [];
  const percent = usage.percent;
  const level = NOTICE_LEVELS.find((candidate) => percent >= candidate);
  if (level === undefined || level <= visibleLevel(ctx)) return [];
  const details: NoticeDetails = {
    level,
    percent: Math.round(percent),
    tokens: usage.tokens,
    contextWindow: usage.contextWindow,
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
