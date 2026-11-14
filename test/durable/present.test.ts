import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPitDurableExtension } from "../../src/durable/index.js";
import type { ToolPresentation } from "../../src/durable/present.js";
import { DurableTestHost, type DurableToolResult } from "../support/durable-harness.js";

let root: string;
let cwd: string;
let agentDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pit-present-"));
  cwd = join(root, "project");
  agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function extension() {
  return createPitDurableExtension({ agentDir });
}

/** The `present` field a host such as pi-action reads from the registered tool. */
function presentation(): ToolPresentation {
  const tool = extension().tools?.find(({ name }) => name === "typescript") as unknown as {
    present: ToolPresentation;
  };
  return tool.present;
}

/** A recorded result in the shape of the ToolResultMessage the host passes. */
const message = (result: DurableToolResult) => ({
  content: [{ type: "text", text: result.text }],
  details: result.details,
  isError: result.isError,
});

async function runOne(args: Record<string, unknown>) {
  const { results } = await new DurableTestHost({ extension: extension(), cwd }).run([args]);
  return message(results[0] as DurableToolResult);
}

const READ = 'async ({ workspace: { read } }) =>\n  read("notes.txt", { format: "raw" })';

describe("the typescript tool's present field", () => {
  it.each([
    {
      name: "the label from the header, as the model sent it",
      args: { code: `// @pit: {"label": "Read the notes"}\n${READ}`, params: null },
      expected: { title: "Read the notes", body: READ },
    },
    {
      name: "the same view of arguments the tool prepared from the header",
      args: { label: "Read the notes", code: `\n${READ}` },
      expected: { title: "Read the notes", body: READ },
    },
    {
      name: "params as indented JSON and the saved-function options",
      args: {
        code: `// @pit: {"label": "Save it", "saveOnly": true}\nasync function f({}, input: { path: string; lines: number[] }) {}`,
        functionId: "notes.f",
        params: {
          path: "a/very/long/path/to/a/file/that/makes/the/json/longer.txt",
          lines: [1, 2],
        },
      },
      expected: {
        title: "Save it",
        body: [
          "async function f({}, input: { path: string; lines: number[] }) {}",
          "params:",
          "  {",
          '    "path": "a/very/long/path/to/a/file/that/makes/the/json/longer.txt",',
          '    "lines": [',
          "      1,",
          "      2",
          "    ]",
          "  }",
          "functionId: notes.f",
          "saveOnly: true",
        ].join("\n"),
      },
    },
    {
      name: "the program's first line without a label",
      args: { code: `\n${READ}`, params: { n: 1 } },
      expected: { title: "async ({ workspace: { read } }) =>", body: `${READ}\nparams: {"n":1}` },
    },
    {
      name: "the program without a malformed header the tool rejected",
      args: { code: `// @pit: {label}\n${READ}` },
      expected: { title: "async ({ workspace: { read } }) =>", body: READ },
    },
  ])("shows a call with $name", ({ args, expected }) => {
    expect(presentation().call(args)).toEqual(expected);
  });

  it("summarizes a result by the functions injected and shows string fields as they are", async () => {
    await writeFile(join(cwd, "notes.txt"), "first line\nsecond line\n");
    const args = { code: `// @pit: {"label": "Read the notes"}\n${READ}` };
    const result = await runOne(args);

    const shown = presentation().result(args, result);

    expect(shown.summary).toBe("workspace.read");
    expect(shown.body).toMatch(/^file: notes.txt$/m);
    expect(shown.body).toContain("\ncontent:\nfirst line\nsecond line\n");
    expect(shown.body).not.toContain("\\n");
  });

  it.each([
    {
      name: "a string as it is",
      code: 'async ({}) => "line one\\nline two"',
      body: "line one\nline two",
    },
    {
      name: "an array as indented JSON",
      code: "async ({}) => [1, { a: 2 }]",
      body: JSON.stringify([1, { a: 2 }], null, 2),
    },
    {
      name: "long fields of an object as indented JSON",
      code: "async ({}) => ({ n: 1, list: Array.from({ length: 30 }, (_, i) => i) })",
      body: `n: 1\nlist:\n  ${JSON.stringify(
        Array.from({ length: 30 }, (_, i) => i),
        null,
        2,
      ).replaceAll("\n", "\n  ")}`,
    },
    { name: "an empty object", code: "async ({}) => ({})", body: "{}" },
  ])("shows $name", async ({ code, body }) => {
    const args = { code };

    const shown = presentation().result(args, await runOne(args));

    expect(shown).toEqual({ body });
  });

  it("shows the result text of a program that returns nothing", async () => {
    const args = { code: "async ({}) => {}" };
    const result = await runOne(args);

    const shown = presentation().result(args, result);

    expect(shown.body).toBe(result.content[0]?.text.trim());
  });

  it("marks a value truncated to fit the output budget", async () => {
    const args = { code: 'async ({}) => "x".repeat(200_000)' };

    const shown = presentation().result(args, await runOne(args));

    expect(shown.body).toMatch(/\n\[Result truncated to fit the output budget\]$/);
    expect(shown.body?.length).toBeLessThan(200_000);
  });

  it("summarizes a failure by the first line of its error", async () => {
    const args = {
      code: 'async ({ git: { status } }) => { throw new Error("no repository\\nsee below"); }',
    };

    const shown = presentation().result(args, await runOne(args));

    expect(shown.summary).toBe("no repository");
    expect(shown.body).toContain("no repository\nsee below");
  });

  it("summarizes a saveOnly call by the function it saved", async () => {
    const args = { code: "async function hello({}) { return 1; }", saveOnly: true };

    const shown = presentation().result(args, await runOne(args));

    expect(shown.summary).toBe("saved hello");
  });

  it.each([
    { name: "blank code", args: { code: "   " }, title: "typescript" },
    { name: "blank code with a functionId", args: { code: "", functionId: "notes.f" }, title: "notes.f" },
    { name: "code that is not a string", args: { code: 42 }, title: "typescript" },
    { name: "arguments that are not an object", args: null, title: "typescript" },
  ])("gives a call with $name a title that is not empty", ({ args }) => {
    const shown = presentation().call(args);

    expect(shown.title).not.toBe("");
  });

  it.each([
    { name: "the call's functionId", args: { code: "async function f({}) {}", functionId: "notes.f" }, summary: "saved notes.f" },
    { name: "the function the code declares", args: { code: "async function hello({}) {}" }, summary: "saved hello" },
    { name: "nothing when no name is known", args: { code: "async ({}) => 1" }, summary: undefined },
  ])("names a saveOnly result without a savedFunction by $name", ({ args, summary }) => {
    const shown = presentation().result(
      { ...args, saveOnly: true },
      { content: [{ type: "text", text: "done" }], details: { value: { executed: false } } },
    );

    expect(shown.summary).toBe(summary);
  });

  it.each([
    { name: "no details", details: undefined },
    { name: "details that are not an object", details: "text" },
  ])("shows a result with $name by its text", ({ details }) => {
    const shown = presentation().result(
      { code: "async ({ git: { status } }) => 1" },
      { content: [{ type: "text", text: "written by the host" }, { type: "image" }], details },
    );

    expect(shown).toEqual({ summary: "git.status", body: "written by the host" });
  });

  it("shows a result whose code is not a string without a summary", () => {
    const shown = presentation().result({ code: 42 }, { content: [], details: {} });

    expect(shown).toEqual({});
  });

  it("shows a failure without text or content as the host's generic view", () => {
    expect(presentation().result({ code: "" }, { isError: true, content: "oops" })).toEqual({});
  });

  it("summarizes a result that asked a question by the question", () => {
    const shown = presentation().result(
      { code: "async ({ ui: { confirm } }) => confirm('Deploy?', 'Ship it')" },
      {
        content: [{ type: "text", text: "Question posted: Deploy?." }],
        details: { question: { key: "k", kind: "confirm", title: "Deploy?" } },
      },
    );

    expect(shown).toEqual({ summary: "asked: Deploy?", body: "Question posted: Deploy?." });
  });
});
