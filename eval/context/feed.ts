import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { Question, Task } from "./tasks.js";

export interface FeedOptions {
  task: Task;
}

export interface FeedState {
  /** Chunks delivered so far. */
  delivered: number;
  pending: Question[];
  answers: Map<string, string>;
  complete: boolean;
  /** Feed calls rejected because they were out of order or named unknown questions. */
  rejectedCalls: number;
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
  };
  return { extension, state };
}
