/**
 * Condition-level context management that does not depend on the task: condition B's
 * compact_context tool and condition E's absolute-token pressure notices.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { noticeText } from "../../src/context/notices.js";
import { NOTICE_TYPE } from "../../src/context/view.js";

export interface PressureOptions {
  /** Condition B: a tool that runs Pi's manual compaction, as Pit's `session.compact()` does. */
  compactTool?: boolean;
  /**
   * Condition E: extra Pit pressure notices when context first reaches each token count. A
   * notice's level is its whole percentage, so a count past 50% of the window also stands in for
   * Pit's 50% notice.
   */
  noticeTokens?: readonly number[];
}

const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export function createPressure(options: PressureOptions) {
  const state = { compactions: 0, failures: 0 };
  // Pi's manual compaction first aborts the running agent turn and waits for it, so a tool that
  // awaited the compaction would deadlock. Like Pit's session.compact(), the tool starts it and
  // ends the turn; the worker resumes once it settles.
  let pending: Promise<boolean> | null = null;
  const thresholds = [...(options.noticeTokens ?? [])].sort((a, b) => b - a);
  const extension = (pi: ExtensionAPI) => {
    if (options.compactTool) {
      pi.registerTool({
        name: "compact_context",
        label: "Compact context",
        description:
          "Compacts the conversation now: Pi summarizes older messages into one summary and keeps recent messages. Optional instructions focus the summary.",
        parameters: Type.Object({ instructions: Type.Optional(Type.String()) }),
        // oxlint-disable-next-line max-params -- Pi defines the tool execute signature.
        execute(_id, params, signal, _update, ctx) {
          const instructions = params.instructions?.trim();
          pending = new Promise<boolean>((settle) => {
            ctx.compact({
              ...(instructions ? { customInstructions: instructions } : {}),
              onComplete: () => {
                state.compactions++;
                settle(true);
              },
              onError: () => {
                state.failures++;
                settle(true);
              },
            });
          });
          const started = reply(
            "Compaction started. This turn ends now; the conversation continues after it.",
          );
          return new Promise((resolve) => {
            if (signal?.aborted) resolve(started);
            else signal?.addEventListener("abort", () => resolve(started), { once: true });
            // A compaction that fails before aborting the turn still ends the tool call.
            void pending?.then(() => resolve(started));
          });
        },
      });
    }
    if (thresholds.length === 0) return;
    pi.on("turn_end", (event, ctx) => {
      // Like Pit, stay quiet in a turn that already recorded edits or a notice.
      if (event.entries.length > 0) return undefined;
      const usage = ctx.getContextUsage();
      if (typeof usage?.tokens !== "number" || typeof usage.percent !== "number") return undefined;
      const tokens = usage.tokens;
      const threshold = thresholds.find((candidate) => tokens >= candidate);
      if (threshold === undefined || threshold <= visibleThreshold(ctx)) return undefined;
      const details = {
        level: Math.floor(usage.percent),
        percent: Math.round(usage.percent),
        tokens,
        contextWindow: usage.contextWindow,
        thresholdTokens: threshold,
      };
      return {
        entries: [
          {
            type: "custom_message" as const,
            customType: NOTICE_TYPE,
            content: noticeText(details),
            display: true,
            details,
          },
        ],
      };
    });
  };
  /** Waits for a model-requested compaction; true when one ran since the last call. */
  const settle = async (): Promise<boolean> => {
    const current = pending;
    pending = null;
    return current ? current : false;
  };
  return { extension, state, settle };
}

/** The largest absolute threshold among notices still in context; a compaction clears them. */
function visibleThreshold(ctx: ExtensionContext): number {
  let threshold = 0;
  for (const { sourceEntry, messages } of ctx.sessionManager.buildSessionProjection().entries) {
    if (sourceEntry.type !== "custom_message" || sourceEntry.customType !== NOTICE_TYPE) continue;
    const details = sourceEntry.details as { thresholdTokens?: unknown } | undefined;
    if (messages.length > 0 && typeof details?.thresholdTokens === "number") {
      threshold = Math.max(threshold, details.thresholdTokens);
    }
  }
  return threshold;
}
