import { describe, expect, it } from "vitest";

import { createFeed } from "../../eval/context/feed.js";
import { spread } from "../../eval/context/report.js";
import { matrix, parseRun } from "../../eval/context/run.js";
import { normalizeAnswer, scoreTask } from "../../eval/context/score.js";
import {
  DEFAULT_SIZE,
  estimateTokens,
  generateTask,
  TASK_KINDS,
  type Task,
} from "../../eval/context/tasks.js";
import { CONTEXT_ONLY, externalWriteCalls, taskPrompt } from "../../eval/context/worker.js";

/** Each question with the text of every chunk up to and including the one that asks it. */
function asked(task: Task) {
  return task.chunks.flatMap((chunk, index) =>
    chunk.questions.map((question) => ({
      question,
      index,
      chunks: task.chunks.slice(0, index + 1),
    })),
  );
}

const match = (text: string, pattern: RegExp) => {
  const found = pattern.exec(text);
  if (!found) throw new Error(`No match for ${pattern} in ${text}`);
  return found;
};

describe("context evaluation tasks", () => {
  it.each(TASK_KINDS)("generates %s deterministically by seed, near the requested size", (kind) => {
    const task = generateTask(kind, 7);
    expect(generateTask(kind, 7)).toEqual(task);
    expect(generateTask(kind, 8).chunks[0]?.text).not.toBe(task.chunks[0]?.text);
    expect(task.chunks).toHaveLength(DEFAULT_SIZE.chunks);
    for (const chunk of task.chunks) {
      expect(estimateTokens(chunk.text)).toBeGreaterThanOrEqual(DEFAULT_SIZE.chunkTokens * 0.9);
      expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(DEFAULT_SIZE.chunkTokens * 1.3);
    }
    expect(task.chunks.at(-1)?.questions.length).toBeGreaterThan(0);
    expect(new Set(asked(task).map(({ question }) => question.id)).size).toBe(asked(task).length);
  });

  // The answer key must follow from the streamed text alone, re-derived here independently.
  it("answers needle questions with the code streamed for the vault", () => {
    for (const { question, index, chunks } of asked(generateTask("needle", 3))) {
      const vault = match(question.prompt, /vault (\S+)\?$/)[1];
      const holder = chunks.findIndex((chunk) =>
        chunk.text.includes(`the access code for vault ${vault} is ${question.answer}.`),
      );
      expect(holder).toBeGreaterThanOrEqual(0);
      expect(question.distance).toBe(index - holder);
    }
  });

  it("answers kv questions with the field of an earlier stored record", () => {
    for (const { question, index, chunks } of asked(generateTask("kv", 3))) {
      const [, field = "", key = ""] = match(
        question.prompt,
        /`(\w+)` of the record stored under (\S+)\?$/,
      );
      const holder = chunks.findIndex((chunk) => chunk.text.includes(`PUT ${key}\n`));
      const text = chunks[holder]?.text ?? "";
      const json =
        match(text.slice(text.indexOf(`PUT ${key}\n`)), /^PUT \S+\n(\{[\s\S]*?\n\})/)[1] ?? "";
      expect(String((JSON.parse(json) as Record<string, unknown>)[field])).toBe(question.answer);
      expect(holder).toBeLessThan(index);
      expect(question.distance).toBe(index - holder);
    }
  });

  it("answers log questions from the ERROR lines in timestamp order", () => {
    const task = generateTask("logs", 3);
    const lines = task.chunks.flatMap((chunk, index) =>
      chunk.text.split("\n").map((line) => ({ line, index })),
    );
    expect(lines.map(({ line }) => line.slice(0, 24))).toEqual(
      lines.map(({ line }) => line.slice(0, 24)).sort(),
    );
    const errors = lines.flatMap(({ line, index }) => {
      const found = / ERROR \[(\S+)\] request (\S+) failed with code (\S+):/.exec(line);
      return found ? [{ service: found[1], request: found[2], code: found[3], index }] : [];
    });
    expect(errors.length).toBeGreaterThanOrEqual(5);
    for (const { question, index } of asked(task)) {
      const seen = errors.filter((error) => error.index <= index);
      const byCode = /error code (\S+)\?$/.exec(question.prompt)?.[1];
      const expected: Record<string, string | undefined> = {
        "How many ERROR lines has the log contained so far?": String(seen.length),
        "Which request did the most recent ERROR line so far report?": seen.at(-1)?.request,
        "What error code did the first ERROR line report?": errors[0]?.code,
        "Which service logged the last ERROR line?": errors.at(-1)?.service,
        "How many ERROR lines did the whole log contain?": String(errors.length),
      };
      const answer = byCode
        ? errors.find((error) => error.code === byCode)?.request
        : expected[question.prompt];
      expect({ prompt: question.prompt, answer }).toEqual({
        prompt: question.prompt,
        answer: question.answer,
      });
    }
  });

  it("answers ledger questions with balances replayed from the transactions", () => {
    const task = generateTask("ledger", 3);
    const balances = new Map<string, number>();
    const effects = new Map<string, Array<[string, number]>>();
    const add = (deltas: Array<[string, number]>, sign: number) => {
      for (const [account, amount] of deltas)
        balances.set(account, (balances.get(account) ?? 0) + sign * amount);
    };
    let checked = 0;
    task.chunks.forEach((chunk) => {
      for (const line of chunk.text.split("\n")) {
        const opening = /^OPENING BALANCES: (.*)$/.exec(line)?.[1];
        if (opening) {
          for (const pair of opening.split(", ")) {
            const [account = "", amount = ""] = pair.split(" ");
            balances.set(account, Number(amount));
          }
          continue;
        }
        const [, id = "", rest = ""] = match(line, /^(TX-\d+) ([^;]+);/);
        const voided = /^VOID (TX-\d+)$/.exec(rest)?.[1];
        if (voided) {
          add(effects.get(voided) ?? [], -1);
          continue;
        }
        const transfer = /^transfer (\d+) from (\w+) to (\w+)$/.exec(rest);
        const deposit = /^deposit (\d+) to (\w+)$/.exec(rest);
        const withdraw = match(rest, transfer || deposit ? /.*/ : /^withdraw (\d+) from (\w+)$/);
        const deltas: Array<[string, number]> = transfer
          ? [
              [transfer[2] ?? "", -Number(transfer[1])],
              [transfer[3] ?? "", Number(transfer[1])],
            ]
          : deposit
            ? [[deposit[2] ?? "", Number(deposit[1])]]
            : [[withdraw[2] ?? "", -Number(withdraw[1])]];
        effects.set(id, deltas);
        add(deltas, 1);
      }
      for (const question of chunk.questions) {
        const account = match(question.prompt, /balance of (\w+)\?$/)[1] ?? "";
        expect(String(balances.get(account))).toBe(question.answer);
        checked++;
      }
    });
    expect(checked).toBeGreaterThanOrEqual(5);
  });
});

describe("context evaluation scoring", () => {
  it.each([
    { name: "quotes, emphasis, and a trailing period", given: " **`K7Q4-M2X9`**. ", correct: true },
    { name: "a different case", given: "k7q4-m2x9", correct: true },
    { name: "extra words", given: "The code is K7Q4-M2X9", correct: false },
    { name: "a different value", given: "K7Q4-M2X8", correct: false },
  ])("scores an answer with $name", ({ given, correct }) => {
    const task: Task = {
      kind: "needle",
      seed: 1,
      description: "",
      chunks: [
        { text: "", questions: [{ id: "q1", prompt: "?", answer: "K7Q4-M2X9", distance: 2 }] },
      ],
    };
    expect(scoreTask(task, new Map([["q1", given]]))).toMatchObject({
      correct: Number(correct),
      total: 1,
      answers: [{ id: "q1", chunk: 0, distance: 2, given, correct }],
    });
  });

  it("removes digit-group commas without touching other digits", () => {
    expect(normalizeAnswer("-1,234,567")).toBe("-1234567");
    expect(normalizeAnswer("12,34")).toBe("12,34");
  });

  it("scores unanswered questions as wrong", () => {
    expect(scoreTask(generateTask("logs", 1), new Map())).toMatchObject({
      correct: 0,
      accuracy: 0,
    });
  });

  it("reports a sample standard deviation only when there are several runs", () => {
    expect([spread([1, 2, 3]), spread([5]), spread([])]).toEqual(["2.0 ± 1.0", "5.0", "–"]);
  });
});

describe("context evaluation feed", () => {
  type Tool = {
    name: string;
    execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>;
  };
  function load(feed: ReturnType<typeof createFeed>) {
    const tools = new Map<string, Tool>();
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    feed.extension({
      registerTool: (tool: Tool) => tools.set(tool.name, tool),
      on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
        handlers.set(name, handler),
    } as never);
    const call = async (name: string, params: unknown = {}) =>
      (await tools.get(name)?.execute("call", params))?.content[0]?.text ?? "";
    return { tools, handlers, call };
  }

  it("delivers chunks once, in order, and holds the stream until questions are answered", async () => {
    const task = generateTask("needle", 1, { chunks: 4, chunkTokens: 500 });
    const feed = createFeed({ task });
    const { tools, call } = load(feed);
    expect([...tools.keys()]).toEqual(["feed_next", "feed_answer"]);
    await expect(call("feed_answer", { answers: [{ id: "q1", answer: "x" }] })).rejects.toThrow(
      "No questions are pending",
    );
    expect(await call("feed_next")).toMatch(/^\[Feed chunk 1 of 4\]\n/);
    const second = await call("feed_next");
    const [first, ...rest] = task.chunks[1]?.questions ?? [];
    expect(second).toContain(`${first?.id}: ${first?.prompt}`);
    await expect(call("feed_next")).rejects.toThrow("Answer the pending questions");
    await expect(call("feed_answer", { answers: [{ id: "q99", answer: "x" }] })).rejects.toThrow(
      "Not pending: q99",
    );
    expect(
      await call("feed_answer", { answers: [{ id: first?.id, answer: first?.answer }] }),
    ).toContain(rest.length > 0 ? "Still pending" : "Continue with feed_next");
    // A repeated answer cannot replace the first one.
    await expect(
      call("feed_answer", { answers: [{ id: first?.id, answer: "changed" }] }),
    ).rejects.toThrow("Not pending");
    await call("feed_answer", {
      answers: rest.map((question) => ({ id: question.id, answer: "wrong" })),
    });
    await call("feed_next");
    const final = task.chunks[3]?.questions ?? [];
    expect(await call("feed_next")).toContain("[Questions:");
    expect(
      await call("feed_answer", { answers: final.map(({ id, answer }) => ({ id, answer })) }),
    ).toContain("The test is complete");
    expect(await call("feed_next")).toBe("The test is complete. No chunks remain.");
    expect(feed.state).toMatchObject({ delivered: 4, complete: true, rejectedCalls: 4 });
    expect(scoreTask(task, feed.state.answers)).toMatchObject({
      correct: 1 + final.length,
      total: 1 + rest.length + final.length,
    });
  });

  it("adds an absolute-token notice once while it stays in context", async () => {
    const feed = createFeed({
      task: generateTask("needle", 1, { chunks: 4, chunkTokens: 500 }),
      noticeTokens: [6000],
    });
    const turnEnd = load(feed).handlers.get("turn_end");
    let tokens = 5000;
    let visible: unknown[] = [];
    const ctx = {
      getContextUsage: () => ({ tokens, percent: (100 * tokens) / 30000, contextWindow: 30000 }),
      sessionManager: { buildSessionProjection: () => ({ entries: visible }) },
    };
    const end = (entries: unknown[] = []) =>
      turnEnd?.({ entries }, ctx) as { entries: Array<{ details: unknown }> } | undefined;
    expect(end()).toBeUndefined();
    tokens = 6500;
    expect(end([{ type: "custom" }])).toBeUndefined();
    const notice = end()?.entries[0];
    expect(notice).toMatchObject({
      type: "custom_message",
      customType: "pit.context-pressure",
      details: {
        level: 21,
        percent: 22,
        tokens: 6500,
        contextWindow: 30000,
        thresholdTokens: 6000,
      },
    });
    visible = [{ sourceEntry: notice, messages: [{}] }];
    expect(end()).toBeUndefined();
    // A compaction that removed the notice lets it fire again.
    visible = [{ sourceEntry: notice, messages: [] }];
    expect(end()?.entries).toHaveLength(1);
  });
});

describe("context evaluation runner", () => {
  it("parses provider/model IDs with nested slashes and orders runs seed-first", () => {
    const options = parseRun([
      "--models",
      "inference.nvidia/aws/anthropic/model-a,openrouter/openai/model-b",
      "--conditions",
      "A,C",
      "--tasks",
      "kv",
      "--seeds",
      "1,2",
      "--out",
      "/tmp/results",
    ]);
    expect(options?.models).toEqual([
      { provider: "inference.nvidia", model: "aws/anthropic/model-a" },
      { provider: "openrouter", model: "openai/model-b" },
    ]);
    expect(options?.noticeTokens).toEqual([6400]);
    expect(matrix(options ?? (null as never)).map((spec) => spec.id)).toEqual([
      "inference.nvidia-aws-anthropic-model-a--A--kv--s1",
      "inference.nvidia-aws-anthropic-model-a--C--kv--s1",
      "openrouter-openai-model-b--A--kv--s1",
      "openrouter-openai-model-b--C--kv--s1",
      "inference.nvidia-aws-anthropic-model-a--A--kv--s2",
      "inference.nvidia-aws-anthropic-model-a--C--kv--s2",
      "openrouter-openai-model-b--A--kv--s2",
      "openrouter-openai-model-b--C--kv--s2",
    ]);
  });

  it.each([
    { name: "an unknown condition", args: ["--conditions", "Z"], error: "Unknown --conditions: Z" },
    {
      name: "a model without a provider",
      args: ["--models", "model"],
      error: "--models needs provider/model",
    },
    {
      name: "a window below the minimum",
      args: ["--window", "100"],
      error: "--window needs integers",
    },
    {
      name: "an unknown memory mode",
      args: ["--memory", "disk"],
      error: "--memory must be one of",
    },
  ])("rejects $name", ({ args, error }) => {
    expect(() => parseRun(["--models", "p/m", ...args])).toThrow(error);
  });

  it("marks context-only runs in their IDs and prompts", () => {
    const options = parseRun([
      "--models",
      "p/m",
      "--conditions",
      "A",
      "--tasks",
      "kv",
      "--seeds",
      "1",
      "--memory",
      "context",
    ]);
    const [spec] = matrix(options ?? (null as never));
    expect(spec).toMatchObject({ id: "p-m--A--kv--s1--context", memory: "context" });
    const task = generateTask("kv", 1, { chunks: 4, chunkTokens: 500 });
    expect(taskPrompt(task, 32000, "context")).toContain(CONTEXT_ONLY);
    expect(taskPrompt(task, 32000)).not.toContain(CONTEXT_ONLY);
  });
});

describe("context evaluation external writes", () => {
  const call = (name: string, code?: string) => ({
    type: "toolCall",
    name,
    arguments: code ? { code } : {},
  });
  it.each([
    { name: "Pi's bash tool", block: call("bash"), writes: 1 },
    { name: "Pi's write tool", block: call("write"), writes: 1 },
    {
      name: "a Pit program using the shell",
      block: call("typescript", "async ({ shell: { execFile } }) => execFile('cat', [])"),
      writes: 1,
    },
    {
      name: "a Pit program editing workspace files",
      block: call("typescript", "async ({ workspace: { edit } }) => edit('a', {})"),
      writes: 1,
    },
    {
      name: "a Pit program editing context only",
      block: call("typescript", "async ({ session: { elide, setNote } }) => elide(['x'])"),
      writes: 0,
    },
    { name: "a feed call", block: call("feed_next"), writes: 0 },
    { name: "text", block: { type: "text", text: "bash" }, writes: 0 },
  ])("counts $name", ({ block, writes }) => {
    expect(externalWriteCalls([block])).toBe(writes);
  });
});
