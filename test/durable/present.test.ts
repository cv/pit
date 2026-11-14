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
      args: { code: `// @pit: {"label": "Read the notes"}\n${READ}` },
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
        params: { path: "a/very/long/path/to/a/file/that/makes/the/json/longer.txt", lines: [1, 2] },
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

  it("shows other returned values as indented JSON", async () => {
    const args = { code: "async ({}) => [1, { a: 2 }]" };

    const shown = presentation().result(args, await runOne(args));

    expect(shown).toEqual({ body: JSON.stringify([1, { a: 2 }], null, 2) });
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
});
