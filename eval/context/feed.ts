import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { noticeText } from "../../src/context/notices.js";
import { NOTICE_TYPE } from "../../src/context/view.js";
import type { Question, Task } from "./tasks.js";

export interface FeedOptions {
  task: Task;
  /** Condition B: a tool that runs Pi's manual compaction, as Pit's `session.compact()` does. */
  compactTool?: boolean;
  /**
   * Condition E: extra Pit pressure notices when context first reaches each token count. A
   * notice's level is its whole percentage, so a count past 50% of the window also stands in for
   * Pit's 50% notice.
   */
  noticeTokens?: readonly number[];
}

export interface FeedState {
  /** Chunks delivered so far. */
  delivered: number;
  pending: Question[];
  answers: Map<string, string>;
  complete: boolean;
  /** Feed calls rejected because they were out of order or named unknown questions. */
  rejectedCalls: number;
  /** Successful compact_context calls. */
  compactions: number;
}

const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
const ids = (items: ReadonlyArray<{ id: string }>) => items.map((item) => item.id).join(", ");

/**
 * The evaluation feed as a Pi extension. Chunks exist only in this process, so a model can see
 * each one once, through a tool result that context editing and compaction can remove.
 */
export function createFeed(options: FeedOptions) {
  const { task } = options;
  const total = task.chunks.length;
  const state: FeedState = {
    delivered: 0,
    pending: [],
    answers: new Map(),
    complete: false,
    rejectedCalls: 0,
    compactions: 0,
  };
  function reject(message: string): never {
    state.rejectedCalls++;
    throw new Error(message);
  }

  const extension = (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "feed_next",
      label: "Feed: next chunk",
      description: `Returns the next chunk of the test feed, which has ${total} chunks and cannot be replayed. When a chunk ends with questions, answer them with feed_answer before calling feed_next again.`,
      parameters: Type.Object({}),
      async execute() {
        if (state.complete) return reply("The test is complete. No chunks remain.");
        if (state.pending.length > 0) {
          reject(`Answer the pending questions with feed_answer first: ${ids(state.pending)}.`);
        }
        const chunk = task.chunks[state.delivered];
        if (!chunk) return reject("No chunks remain.");
        state.delivered++;
        state.pending = [...chunk.questions];
        const questions =
          chunk.questions.length === 0
            ? ""
            : `\n\n[Questions: answer each with feed_answer before calling feed_next again. Give only the bare value.]\n${chunk.questions
                .map((question) => `${question.id}: ${question.prompt}`)
                .join("\n")}`;
        return reply(
          `[Feed chunk ${state.delivered} of ${total}]\n${chunk.text}\n[End of chunk ${state.delivered}]${questions}`,
        );
      },
    });

    pi.registerTool({
      name: "feed_answer",
      label: "Feed: answer",
      description:
        "Records answers to the pending feed questions. Each answer is final. Give only the bare value, such as a code, name, or number.",
      parameters: Type.Object({
        answers: Type.Array(
          Type.Object({
            id: Type.String({ description: "Question ID, such as q3" }),
            answer: Type.String(),
          }),
          { minItems: 1 },
        ),
      }),
      async execute(_id, params) {
        if (state.pending.length === 0) reject("No questions are pending; call feed_next.");
        const pending = new Set(state.pending.map((question) => question.id));
        const unknown = params.answers.filter((answer) => !pending.has(answer.id));
        if (unknown.length > 0) {
          reject(`Not pending: ${ids(unknown)}. Pending: ${ids(state.pending)}.`);
        }
        for (const { id, answer } of params.answers) {
          if (!state.answers.has(id)) state.answers.set(id, answer);
        }
        state.pending = state.pending.filter((question) => !state.answers.has(question.id));
        if (state.pending.length > 0)
          return reply(`Recorded. Still pending: ${ids(state.pending)}.`);
        if (state.delivered >= total) {
          state.complete = true;
          return reply("All questions answered. The test is complete; stop here.");
        }
        return reply(
          `Recorded. Continue with feed_next; ${total - state.delivered} chunks remain.`,
        );
      },
    });

    if (options.compactTool) {
      pi.registerTool({
        name: "compact_context",
        label: "Compact context",
        description:
          "Compacts the conversation now: Pi summarizes older messages into one summary and keeps recent messages. Optional instructions focus the summary.",
        parameters: Type.Object({ instructions: Type.Optional(Type.String()) }),
        // oxlint-disable-next-line max-params -- Pi defines the tool execute signature.
        execute(_id, params, _signal, _update, ctx) {
          const instructions = params.instructions?.trim();
          return new Promise((resolve, fail) => {
            ctx.compact({
              ...(instructions ? { customInstructions: instructions } : {}),
              onComplete: (result) => {
                state.compactions++;
                resolve(reply(`Compacted; context held ~${result.tokensBefore} tokens before.`));
              },
              onError: fail,
            });
          });
        },
      });
    }

    const thresholds = [...(options.noticeTokens ?? [])].sort((a, b) => b - a);
    if (thresholds.length > 0) {
      pi.on("turn_end", (event, ctx) => {
        // Like Pit, stay quiet in a turn that already recorded edits or a notice.
        if (event.entries.length > 0) return undefined;
        const usage = ctx.getContextUsage();
        if (typeof usage?.tokens !== "number" || typeof usage.percent !== "number")
          return undefined;
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
    }
  };
  return { extension, state };
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
