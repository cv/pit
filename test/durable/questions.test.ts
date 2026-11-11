import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPitDurableExtension, type PitDurableUi } from "../../src/durable/index.js";
import { questionKey, type UiQuestion } from "../../src/durable/questions.js";
import { DurableTestHost } from "../support/durable-harness.js";

let root: string;
let cwd: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pit-durable-questions-"));
  cwd = join(root, "repo");
  await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A host that posts questions, as a GitHub thread does, and remembers them. */
function asyncHost(options: { trustProject?: boolean; noUrl?: boolean } = {}) {
  const { noUrl, ...extension } = options;
  const asked: UiQuestion[] = [];
  const ui: PitDurableUi = {
    ask: async (question) => {
      asked.push(question);
      return noUrl ? {} : { url: `https://example.test/q/${asked.length}` };
    },
    notify: () => undefined,
  };
  const durable = new DurableTestHost({
    extension: createPitDurableExtension({ agentDir: join(root, "agent"), ui, ...extension }),
    cwd,
  });
  /** The submission a host makes when someone answers: a user message placed as the answer. */
  const answer = (question: UiQuestion, value: boolean | string) => ({
    content: `**@octocat** answered pi's question *${question.title}*: ${String(value)}`,
    entry: {
      kind: "ui.answer",
      data: { key: question.key, kind: question.kind, answer: value, by: "octocat" },
    },
  });
  return { durable, asked, answer };
}

const CONFIRM = { code: 'async ({ ui: { confirm } }) => confirm("Deploy?", "Ship it")' };

describe("questions on asynchronous pi-durable hosts", () => {
  it.each<[Parameters<typeof questionKey>[0], string]>([
    [{ kind: "confirm", title: "Deploy?", message: "Ship it" }, "9d3f829216bd5524"],
    [{ kind: "select", title: "Pick one", options: ["a", "b"] }, "f6c67e2bcf63dc96"],
    [{ kind: "input", title: "Name?" }, "ef5593bb86c0c752"],
    [{ kind: "input", title: "Name?", placeholder: "e.g. Ada" }, "18a63bc94f4c934d"],
  ])("keys %o as hosts compute it", (question, key) => {
    expect(questionKey(question)).toBe(key);
  });

  it("posts a question, ends the turn without an error, and keeps earlier calls recoverable", async () => {
    await writeFile(join(cwd, "plan.txt"), "ship on friday\n");
    const { durable, asked } = asyncHost();
    // The run ends after the question's round, so the next program never runs.
    const { results } = await durable.run([
      {
        code: `async ({ workspace: { read }, ui: { confirm } }) => {
  await read("plan.txt");
  try {
    return await confirm("Deploy?", "Ship it");
  } catch {
    return "carried on";
  }
}`,
      },
      { code: 'async () => "never runs"' },
    ]);
    expect(asked).toEqual([
      { kind: "confirm", key: "9d3f829216bd5524", title: "Deploy?", message: "Ship it" },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]?.isError).toBe(false);
    expect(results[0]?.text).toMatch(
      /^Question posted: Deploy\? \(https:\/\/example\.test\/q\/1\)\. The answer will arrive as a later message; end your turn now\. .*runtime\.completedCalls\("/,
    );
    expect(results[0]?.details.question).toEqual({
      key: "9d3f829216bd5524",
      kind: "confirm",
      title: "Deploy?",
      url: "https://example.test/q/1",
    });
  });

  it("returns a later answer once, and asks anew after a successful call used it", async () => {
    const { durable, asked, answer } = asyncHost();
    await durable.run([CONFIRM]);
    const question = asked[0] as UiQuestion;
    const answered = await durable.run(
      [
        {
          code: 'async ({ ui: { confirm } }) => { await confirm("Deploy?", "Ship it"); throw new Error("build broke"); }',
        },
        CONFIRM,
      ],
      undefined,
      answer(question, true),
    );
    // The failed call did not use up the answer, so the retry gets it.
    expect(answered.results[0]?.isError).toBe(true);
    expect(answered.results[1]).toMatchObject({ isError: false, details: { value: true } });
    expect(asked).toHaveLength(1);

    const again = await durable.run([CONFIRM]);
    expect(again.results[0]?.text).toMatch(/^Question posted: Deploy\?/);
    expect(asked).toHaveLength(2);
  });

  it.each([
    ["select", 'async ({ ui: { select } }) => select("Pick one", ["a", "b"])', "b"],
    ["input", 'async ({ ui: { input } }) => input("Name?")', "Ada"],
  ])("answers %s questions from the conversation", async (_kind, code, value) => {
    const { durable, asked, answer } = asyncHost();
    await durable.run([{ code }]);
    const { results } = await durable.run(
      [{ code }],
      undefined,
      answer(asked[0] as UiQuestion, value),
    );
    expect(results[0]?.details.value).toBe(value);
  });

  it("skips an answer of the wrong type and asks again", async () => {
    const { durable, asked, answer } = asyncHost();
    await durable.run([CONFIRM]);
    const { results } = await durable.run(
      [CONFIRM],
      undefined,
      answer(asked[0] as UiQuestion, "yes please"),
    );
    expect(results[0]?.text).toMatch(/^Question posted/);
    expect(asked).toHaveLength(2);
  });

  it("asks before promoting to the project and promotes once answered", async () => {
    const { durable, asked, answer } = asyncHost({ trustProject: true });
    const save = { code: "/** Runs the tests. */\nasync function runTests({}) { return 'ok'; }" };
    const promote = {
      code: 'async ({ functions: { promote } }) => promote("runTests", "Runs the tests.")',
    };
    const asking = await durable.run([save, promote]);
    expect(asking.results[1]?.text).toMatch(/^Question posted: Save runTests to the project\?/);
    await expect(stat(join(cwd, ".pi/functions/runTests.ts"))).rejects.toThrow();

    const done = await durable.run([promote], undefined, answer(asked[0] as UiQuestion, true));
    expect(done.results[0]?.details.value).toMatchObject({ promoted: true, scope: "project" });
    await expect(stat(join(cwd, ".pi/functions/runTests.ts"))).resolves.toBeDefined();
  });

  it("uses one answer per question and posts only the first unanswered question", async () => {
    const { durable, asked, answer } = asyncHost({ noUrl: true });
    await durable.run([CONFIRM]);
    const twice = {
      code: `async ({ ui: { confirm, input } }) => {
  await confirm("Deploy?", "Ship it");
  await Promise.all([confirm("Deploy?", "Ship it"), input("Name?", "e.g. Ada")]);
}`,
    };
    const { results } = await durable.run([twice], undefined, answer(asked[0] as UiQuestion, true));
    // Without a URL, the result names only the question.
    expect(results[0]?.text).toMatch(
      /^Question posted: Deploy\?\. The answer will arrive as a later message; end your turn now\./,
    );
    expect(results[0]?.details.question).not.toHaveProperty("url");
    // The second question in the same program was not posted after the first ended it.
    expect(asked.map((question) => question.kind)).toEqual(["confirm", "confirm"]);
  });

  it("skips a select answer that is not text", async () => {
    const { durable, asked, answer } = asyncHost();
    const pick = { code: 'async ({ ui: { select } }) => select("Pick one", ["a", "b"])' };
    await durable.run([pick]);
    const { results } = await durable.run([pick], undefined, answer(asked[0] as UiQuestion, true));
    expect(results[0]?.text).toMatch(/^Question posted: Pick one/);
  });

  it("fails a dialog an interactive host does not implement, as Pi does without a UI", async () => {
    const durable = new DurableTestHost({
      extension: createPitDurableExtension({
        agentDir: join(root, "agent"),
        ui: { confirm: async () => true, notify: () => undefined },
      }),
      cwd,
    });
    const { results } = await durable.run([
      CONFIRM,
      { code: 'async ({ ui: { select } }) => select("Pick one", ["a"])' },
    ]);
    expect(results[0]?.details.value).toBe(true);
    expect(results[1]?.text).toMatch(/^UI is not available in this mode/);
  });

  it("reports hasUI for a host that only asks", async () => {
    const { durable } = asyncHost();
    const { results } = await durable.run([
      { code: "async ({ context: { get } }) => ((await get()) as { hasUI?: boolean }).hasUI" },
    ]);
    expect(results[0]?.details.value).toBe(true);
  });
});
