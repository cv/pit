import { createHash } from "node:crypto";

import type { ToolExecutionApi } from "@earendil-works/pi-durable";

import { isRecord } from "../shared/records.js";

type ToolContext = Parameters<ToolExecutionApi["commit"]>[1];

/** A question Pit asks a person through an asynchronous host, such as a GitHub comment. */
export type UiQuestion =
  | { kind: "confirm"; key: string; title: string; message: string }
  | { kind: "select"; key: string; title: string; options: string[] }
  | { kind: "input"; key: string; title: string; placeholder?: string };

type QuestionDraft = UiQuestion extends infer Q
  ? Q extends UiQuestion
    ? Omit<Q, "key">
    : never
  : never;

/** The entry a host writes with a person's answer; `data` is `{ key, kind, answer, by?, url? }`. */
export const ANSWER_KIND = "ui.answer";
/** The passive entry Pit writes when a successful call used an answer. */
export const CONSUMED_KIND = "ui.answer-consumed";

const SCAN_PAGE = 256;
const KEY_HEX_CHARS = 16;

/**
 * The question's stable key: `sha256(JSON.stringify([kind, title, detail]))`, its first 16 hex
 * characters, where `detail` is the confirm message, the select options, or the input placeholder
 * (`null` when absent). The host puts it in its marker and in the `ui.answer` entry.
 */
export function questionKey(question: QuestionDraft): string {
  const detail =
    question.kind === "confirm"
      ? question.message
      : question.kind === "select"
        ? question.options
        : (question.placeholder ?? null);
  return createHash("sha256")
    .update(JSON.stringify([question.kind, question.title, detail]))
    .digest("hex")
    .slice(0, KEY_HEX_CHARS);
}

/** Why a program stopped: it asked a question the host posted, to be answered in a later run. */
export class QuestionPosted extends Error {
  override readonly name = "QuestionPosted";
  readonly question: UiQuestion;
  readonly url: string | undefined;

  constructor(question: UiQuestion, url: string | undefined) {
    super(`Question posted: ${question.title}${url ? ` (${url})` : ""}`);
    this.question = question;
    this.url = url;
  }
}

function answerOf(question: UiQuestion, value: unknown): boolean | string | undefined {
  if (question.kind === "confirm") return typeof value === "boolean" ? value : undefined;
  return typeof value === "string" ? value : undefined;
}

/**
 * Questions for one `typescript` call on a host that answers asynchronously. A question with an
 * unused answer in the conversation returns it; any other is posted through the host's `ask`, and
 * the call ends. Answers a call used are recorded as consumed only if the call succeeds, so a
 * program that fails can ask again and get the same answer.
 */
export class DurableQuestions {
  readonly #api: Pick<ToolExecutionApi, "commit" | "conversation" | "conversationId">;
  readonly #context: ToolContext;
  readonly #ask: (question: UiQuestion) => Promise<{ url?: string }>;
  readonly #onPosted: (posted: QuestionPosted) => void;
  readonly #used: string[] = [];
  #posted: QuestionPosted | undefined;

  constructor(input: {
    api: Pick<ToolExecutionApi, "commit" | "conversation" | "conversationId">;
    context: ToolContext;
    ask: (question: UiQuestion) => Promise<{ url?: string }>;
    /** Stops the program, so it cannot catch the question and carry on. */
    onPosted: (posted: QuestionPosted) => void;
  }) {
    this.#api = input.api;
    this.#context = input.context;
    this.#ask = input.ask;
    this.#onPosted = input.onPosted;
  }

  /** The question this call posted, if it ended on one. */
  get posted(): QuestionPosted | undefined {
    return this.#posted;
  }

  async confirm(title: string, message: string): Promise<boolean> {
    return (await this.#answer({ kind: "confirm", title, message })) as boolean;
  }

  async select(title: string, options: string[]): Promise<string | undefined> {
    return (await this.#answer({ kind: "select", title, options: [...options] })) as string;
  }

  async input(title: string, placeholder?: string): Promise<string | undefined> {
    return (await this.#answer({
      kind: "input",
      title,
      ...(placeholder === undefined ? {} : { placeholder }),
    })) as string;
  }

  /** Records the answers this call used, once it succeeded. */
  async recordConsumed(): Promise<void> {
    if (this.#used.length === 0) return;
    const conversation = await this.#api.conversation(this.#api.conversationId, this.#context);
    /* v8 ignore next -- a running call's own conversation exists. */
    if (!conversation) throw new Error(`Conversation ${this.#api.conversationId} is unavailable`);
    for (const key of this.#used.splice(0)) {
      await conversation.submit(
        { type: "write", entry: { kind: CONSUMED_KIND, data: { key } } },
        this.#context,
      );
    }
  }

  async #answer(draft: QuestionDraft): Promise<boolean | string> {
    const question = { ...draft, key: questionKey(draft) } as UiQuestion;
    const answers = (await this.#unusedAnswers()).get(question.key) ?? [];
    const available = answers.slice(this.#used.filter((key) => key === question.key).length);
    for (const value of available) {
      const answer = answerOf(question, value);
      this.#used.push(question.key);
      if (answer !== undefined) return answer;
    }
    // Once a question ends the program, later questions from it are not posted.
    if (this.#posted) throw this.#posted;
    const { url } = await this.#ask(question);
    const posted = new QuestionPosted(question, url);
    this.#posted ??= posted;
    this.#onPosted(posted);
    throw posted;
  }

  /** Answers in the conversation not yet consumed, per key, oldest first. */
  async #unusedAnswers(): Promise<Map<string, unknown[]>> {
    const { conversationId } = this.#api;
    const answers = new Map<string, unknown[]>();
    await this.#api.commit(async (tx) => {
      const query = { conversationId, order: "ascending" } as const;
      let page = await tx.scanEntries(query, SCAN_PAGE);
      for (;;) {
        for (const entry of page.items) {
          const data = entry.data;
          if (!isRecord(data) || typeof data.key !== "string") continue;
          if (entry.kind === ANSWER_KIND) {
            answers.set(data.key, [...(answers.get(data.key) ?? []), data.answer]);
          } else if (entry.kind === CONSUMED_KIND) {
            answers.get(data.key)?.shift();
          }
        }
        if (page.next === undefined) break;
        page = await tx.scanEntries(query, SCAN_PAGE, page.next);
      }
    }, this.#context);
    return answers;
  }
}
