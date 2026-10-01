import type { Task } from "./tasks.js";

export interface ScoredAnswer {
  id: string;
  /** Index of the chunk that asked the question. */
  chunk: number;
  distance: number;
  expected: string;
  /** The model's answer, or null when it never answered. */
  given: string | null;
  correct: boolean;
}

export interface Score {
  correct: number;
  total: number;
  accuracy: number;
  answers: ScoredAnswer[];
}

/**
 * Exact scoring after normalizing presentation only: case, surrounding whitespace, quotes,
 * backticks, emphasis, a trailing period, and digit-group commas. Extra words are wrong, because
 * the feed asks for the bare value.
 */
export function normalizeAnswer(value: string): string {
  return value
    .trim()
    .replace(/^[\s"'`*]+|[\s"'`*.]+$/g, "")
    .replace(/(\d),(?=\d{3}(?!\d))/g, "$1")
    .toLowerCase();
}

export function scoreTask(task: Task, answers: ReadonlyMap<string, string>): Score {
  const scored = task.chunks.flatMap((chunk, index) =>
    chunk.questions.map((question) => {
      const given = answers.get(question.id) ?? null;
      return {
        id: question.id,
        chunk: index,
        distance: question.distance,
        expected: question.answer,
        given,
        correct: given !== null && normalizeAnswer(given) === normalizeAnswer(question.answer),
      };
    }),
  );
  const correct = scored.filter((answer) => answer.correct).length;
  return {
    correct,
    total: scored.length,
    accuracy: scored.length === 0 ? 0 : correct / scored.length,
    answers: scored,
  };
}
