import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolRegistration } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPiDurableExtension,
  createPitDurableExtension,
  type PitDurableOptions,
} from "../../src/durable/index.js";
import { DurableTestHost } from "../support/durable-harness.js";

let root: string;
let cwd: string;
let agentDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pit-durable-"));
  cwd = join(root, "project");
  agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function host(options: PitDurableOptions = {}, tools?: ToolRegistration[]): DurableTestHost {
  return new DurableTestHost({
    extension: createPitDurableExtension({ agentDir, ...options }),
    cwd,
    ...(tools ? { tools } : {}),
  });
}

async function writeFunction(directory: string, name: string, source: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.ts`), source);
}

const ECHO: ToolRegistration = {
  name: "echo",
  description: "Echoes text.",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  execute: async (args: any) => ({ output: [{ type: "text", text: `echo: ${args.text}` }] }),
};

const MEASURE: ToolRegistration = {
  name: "measure",
  description: "Measures text.",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  structuredOutputSchema: {
    type: "object",
    properties: { length: { type: "number" } },
    required: ["length"],
  },
  execute: async (args: any) => ({
    output: [{ type: "text", text: String(args.text.length) }],
    structuredOutput: { length: args.text.length },
  }),
};

const THROW: ToolRegistration = {
  name: "crash",
  description: "Throws.",
  parameters: { type: "object", properties: {} },
  execute: async () => {
    throw new Error("tool crashed");
  },
};

const CHART: ToolRegistration = {
  name: "chart",
  description: "Draws a chart.",
  parameters: { type: "object", properties: {} },
  execute: async () => ({
    output: [
      { type: "text", text: "chart drawn" },
      { type: "image", data: "aGk=", mimeType: "image/png" },
    ],
  }),
};

const PHOTO: ToolRegistration = {
  name: "photo",
  description: "Takes a photo.",
  parameters: { type: "object", properties: {} },
  execute: async () => ({ output: [{ type: "image", data: "aGk=", mimeType: "image/png" }] }),
};

const SILENT_FAIL: ToolRegistration = {
  name: "quietly",
  description: "Fails without saying why.",
  parameters: { type: "object", properties: {} },
  execute: async () => ({ isError: true, output: [] }),
};

const FAIL: ToolRegistration = {
  name: "fail",
  description: "Always fails.",
  parameters: { type: "object", properties: {} },
  execute: async () => ({ isError: true, output: [{ type: "text", text: "disk full" }] }),
};

describe("pit on a pi-durable Harness", () => {
  it("runs a model's program that reads a file and runs a command", async () => {
    await writeFile(join(cwd, "notes.txt"), "durable notes\n");
    const { results } = await host().run([
      {
        code: `async ({ workspace: { read }, shell: { exec } }) => ({
          notes: (await read("notes.txt", { format: "raw" })).content,
          shell: (await exec("pwd && echo ran")).stdout,
        })`,
      },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]?.isError).toBe(false);
    expect(results[0]?.details.value).toEqual({
      notes: "durable notes\n",
      shell: expect.stringMatching(/project\nran\n$/),
    });
  });

  it("keeps session functions in conversation entries across a reopened Harness", async () => {
    const durable = host();
    const saved = await durable.run([
      { code: "async function greet({}, name: string = 'you') { return `hi ${name}`; }" },
    ]);
    expect(saved.results[0]?.text).toContain('[Saved function "greet"');
    const entries = await durable.entries(await durable.root(), "pit-function-definitions");
    expect(entries.map((entry) => entry.data)).toEqual([
      { name: "greet", source: expect.stringContaining("async function greet") },
    ]);

    await durable.close();
    const reopened = await durable.run([
      { code: 'async ({ greet }) => greet("again")' },
      { code: "async ({ context: { get } }) => (await get()).sessionFunctions" },
    ]);
    expect(reopened.results.map((result) => result.details.value)).toEqual(["hi again", ["greet"]]);
  });

  it("carries session functions into a fork without sharing the fork's later changes", async () => {
    const durable = host();
    const parent = await durable.root();
    await durable.run([{ code: "async function base({}) { return 'base'; }" }], parent);
    const fork = await durable.fork(parent);
    const inFork = await durable.run(
      [
        { code: "async ({ base }) => base()" },
        { code: "async function forked({}) { return 'forked'; }" },
      ],
      fork,
    );
    expect(inFork.results[0]?.details.value).toBe("base");

    const inParent = await durable.run(
      [{ code: "async ({ context: { get } }) => (await get()).sessionFunctions" }],
      parent,
    );
    expect(inParent.results[0]?.details.value).toEqual(["base"]);
  });

  it("reaches the host's tools through tools.* and toolIndex.*", async () => {
    const { results } = await host({}, [ECHO, MEASURE, FAIL]).run([
      {
        code: `async ({ tools: { echo, measure }, toolIndex: { search } }) => ({
          echoed: await echo({ text: "hi" }),
          measured: await measure({ text: "four" }),
          found: (await search("measures")).map((tool) => tool.name),
        })`,
      },
      { code: "async ({ tools: { fail } }) => fail()" },
    ]);
    expect(results[0]?.details.value).toEqual({
      echoed: "echo: hi",
      measured: { length: 4 },
      found: ["measure"],
    });
    expect(results[1]).toMatchObject({ isError: true, text: "fail failed: disk full" });
  });

  it.each([
    ["commands.list", "async ({ commands: { list } }) => list()"],
    ["session.outline", "async ({ session: { outline } }) => outline()"],
    ["models.set", 'async ({ models: { set } }) => set("faux", "faux-model")'],
    ["workspace.viewImage", 'async ({ workspace: { viewImage } }) => viewImage("a.png")'],
  ])("reports %s as unavailable on pi-durable hosts", async (global, code) => {
    const { results } = await host().run([{ code }]);
    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.text).toMatch(new RegExp(`^${global} is unavailable on pi-durable hosts`));
  });

  it("reaches the host's coding tools through tools.* and lists them for the model", async () => {
    await writeFile(join(cwd, "notes.txt"), "from the host's read tool\n");
    const durable = new DurableTestHost({
      extension: createPitDurableExtension({ agentDir: join(root, "agent") }),
      extensions: [CodingTools],
      env: true,
      cwd,
    });
    const { results, sections } = await durable.run([
      {
        code: `async ({ tools: { read, bash } }) => ({
  read: await read({ path: "notes.txt" }),
  bash: await bash({ command: "echo from-bash" }),
})`,
      },
    ]);
    expect(results[0]?.isError).toBe(false);
    expect(results[0]?.details.value.read).toContain("from the host's read tool");
    // bash declares structured output, so programs get its fields.
    expect(results[0]?.details.value.bash).toMatchObject({ output: "from-bash\n", exitCode: 0 });
    expect(sections.pit_tools).toMatch(/injectable from `tools`: .*\bread\b.*\bbash\b/);
    expect(sections.pit_tools).not.toMatch(/\btypescript\b/);
  });

  it("pauses the program deadline while a host dialog waits for its answer", async () => {
    // The deadline leaves room for a slow runner to start the program; the dialog and the command
    // each outlast it by half again, so only the pause lets the dialog's program finish.
    const deadlineMs = 2_000;
    const outlastMs = deadlineMs * 1.5;
    const slowUi = {
      confirm: async () => {
        await new Promise((resolve) => setTimeout(resolve, outlastMs));
        return true;
      },
      select: async () => undefined,
      input: async () => undefined,
      notify: () => undefined,
    };
    const { results } = await host({ ui: slowUi }).run([
      {
        code: 'async ({ ui: { confirm } }) => confirm("Deploy?", "Ship it")',
        timeoutMs: deadlineMs,
      },
      {
        code: `async ({ shell: { exec } }) => exec("sleep ${outlastMs / 1000}")`,
        timeoutMs: deadlineMs,
      },
    ]);
    expect(results[0]).toMatchObject({ isError: false, details: { value: true } });
    // Other host calls still count against the deadline.
    expect(results[1]?.isError).toBe(true);
    expect(results[1]?.text).toMatch(new RegExp(`timed out after ${deadlineMs}ms`));
  });

  it("behaves as Pi without a UI unless the host passes dialogs", async () => {
    const programs = [
      // The shared contract does not declare hasUI; pi-durable hosts add it.
      { code: "async ({ context: { get } }) => ((await get()) as { hasUI?: boolean }).hasUI" },
      { code: 'async ({ ui: { confirm } }) => confirm("Deploy?", "Ship it")' },
    ];
    const headless = await host().run(programs);
    expect(headless.results[0]?.details.value).toBe(false);
    expect(headless.results[1]).toMatchObject({
      isError: true,
      text: "UI is not available in this mode",
    });

    const confirm = vi.fn(async () => true);
    const ui = { confirm, input: vi.fn(), select: vi.fn(), notify: vi.fn() };
    const interactive = await host({ ui }).run(programs);
    expect(interactive.results.map((result) => result.details.value)).toEqual([true, true]);
    expect(confirm).toHaveBeenCalledWith("Deploy?", "Ship it", expect.anything());
  });

  it("loads project functions only from a trusted project", async () => {
    await writeFunction(
      join(cwd, ".pi/functions"),
      "projectHello",
      "/** Greets from the project. */\nasync function projectHello({}) { return 'project hello'; }",
    );
    const program = [{ code: "async ({ projectHello }) => projectHello()" }];
    const log = { info: vi.fn(), warning: vi.fn() };

    const untrusted = await host({ log }).run(program);
    expect(untrusted.results[0]?.isError).toBe(true);
    expect(untrusted.sections.pit_project_functions).toBeUndefined();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("the project is not trusted (trustProject is false)"),
    );

    const trusted = await host({ trustProject: true }).run(program);
    expect(trusted.results[0]?.details.value).toBe("project hello");
    expect(trusted.sections.pit_project_functions).toContain("projectHello()");
  });

  it("lists user functions from the agent directory and runs them", async () => {
    await writeFunction(
      join(agentDir, "functions"),
      "userHello",
      "/** Greets from the user scope. */\nasync function userHello({}) { return 'user hello'; }",
    );
    const { results, sections } = await host().run([
      { code: "async ({ userHello }) => userHello()" },
    ]);
    expect(results[0]?.details.value).toBe("user hello");
    expect(sections.pit_user_functions).toContain("userHello()");
    expect(sections.pit_guidelines).toContain("Use typescript for host work");
    // Context editing is not available yet, so its guideline is left out.
    expect(sections.pit_guidelines).not.toContain("session.setNote");
  });

  it("warns once, to the log and the first result, about saved functions that fail to load", async () => {
    await writeFunction(join(agentDir, "functions"), "broken", "async function broken({}) {");
    const log = { info: vi.fn(), warning: vi.fn() };
    const { results } = await host({ log }).run([
      { code: "async () => 1" },
      { code: "async () => 2" },
    ]);
    expect(results[0]?.diagnostics).toEqual([
      {
        severity: "warn",
        message: expect.stringContaining("Some saved functions could not be loaded: "),
      },
    ]);
    expect(results[1]?.diagnostics).toEqual([]);
    expect(log.warning).toHaveBeenCalledTimes(1);
  });

  it("describes the host's model and recovers a failed program's completed calls", async () => {
    await writeFile(join(cwd, "data.txt"), "kept");
    const durable = host();
    const { results } = await durable.run([
      {
        code: `async ({ models: { current, list }, runtime: { status } }) => ({
          current: (await current())?.id,
          listed: (await list({ availableOnly: false })).models.map((model) => model.id),
          status: await status(),
        })`,
      },
      {
        code: `async ({ workspace: { read } }) => {
          await read("data.txt", { format: "raw" });
          throw new Error("after the read");
        }`,
      },
    ]);
    expect(results[0]?.details.value).toEqual({
      current: "faux-model",
      listed: ["faux-model"],
      status: { mode: "durable", idle: false, pendingMessages: false },
    });
    const failed = results[1];
    expect(failed?.isError).toBe(true);
    expect(failed?.text).toContain("after the read");
    const recovered = await durable.run([
      {
        code: "async ({ runtime: { completedCalls } }, id: string) => completedCalls(id)",
        params: failed?.details.recoverable.toolCallId,
      },
    ]);
    expect(recovered.results[0]?.details.value).toMatchObject({
      calls: [
        {
          sequence: 1,
          call: "workspace.read",
          value: expect.objectContaining({ content: "kept" }),
        },
      ],
    });
  });

  it("reports the host tools' misuse and failures to the program", async () => {
    const { results } = await host({}, [ECHO, THROW, CHART, PHOTO, SILENT_FAIL]).run([
      {
        code: `async ({ tools: { echo, crash, chart, photo, quietly }, toolIndex: { describe, search } }) => ({
          described: (await describe("echo"))?.includes("echo"),
          extra: await (echo as any)({ text: "a" }, {}).catch((error: Error) => error.message),
          notObject: await (echo as any)("a").catch((error: Error) => error.message),
          crashed: await crash().catch((error: Error) => error.message),
          chart: await chart(),
          photo: await photo(),
          quietly: await quietly().catch((error: Error) => error.message),
          firstMatch: (await search("chart", 1)).map((tool) => tool.name),
        })`,
      },
    ]);
    expect(results[0]?.details.value).toEqual({
      described: true,
      extra: "tools.echo expects 0-1 argument(s); received 2",
      notObject: "tools.echo expects an arguments object",
      crashed: expect.stringMatching(/^crash failed: .*tool crashed/),
      chart: "chart drawn",
      photo: "",
      quietly: "quietly failed",
      firstMatch: ["chart"],
    });
    expect(results[0]?.text).toContain(
      "Image from chart not attached: images are unavailable on pi-durable hosts",
    );
  });

  it("saves a dotted function without running it and injects it by namespace", async () => {
    const { results } = await host().run([
      {
        code: "async function check({}) { return 'checked'; }",
        functionId: "team.check",
        saveOnly: true,
      },
      { code: "async ({ team: { check } }) => check()" },
    ]);
    expect(results[0]?.text).toContain('[Saved function "team.check" without executing it');
    expect(results[1]?.details.value).toBe("checked");
  });

  it("lets a session function shadow a trusted project's and keeps promotion behind trust", async () => {
    await writeFunction(
      join(cwd, ".pi/functions"),
      "projectHello",
      "/** Greets from the project. */\nasync function projectHello({}) { return 'project hello'; }",
    );
    const trusted = await host({ trustProject: true }).run([
      {
        code: "/** Greets from the project. */\nasync function projectHello({}) { return 'updated'; }",
      },
      { code: "async ({ projectHello }) => projectHello()" },
    ]);
    expect(trusted.results[0]?.text).toContain('[Saved function "projectHello"');
    expect(trusted.results[1]?.details.value).toBe("updated");

    const untrusted = await host().run([
      { code: "async function local({}) { return 1; }" },
      {
        code: 'async ({ functions: { promote } }) => promote("local", "Returns one.")',
      },
    ]);
    expect(untrusted.results[1]?.isError).toBe(true);
    expect(untrusted.results[1]?.text).toMatch(/trust/i);
  });

  it("asks the host before a program writes or removes a trusted project's function files", async () => {
    const asked: string[] = [];
    const answering = (answer: boolean) => ({
      confirm: async (title: string) => {
        asked.push(title);
        return answer;
      },
      select: async () => undefined,
      input: async () => undefined,
      notify: () => undefined,
    });
    const save = { code: "/** Runs the tests. */\nasync function runTests({}) { return 'ok'; }" };
    const promote = {
      code: 'async ({ functions: { promote } }) => promote("runTests", "Runs the tests.")',
    };
    const file = join(cwd, ".pi/functions/runTests.ts");

    // Nothing to promote or remove: no question, and the promotion fails as it would after one.
    const missing = await host({ trustProject: true, ui: answering(true) }).run([
      promote,
      { code: 'async ({ functions: { remove } }) => remove("runTests")' },
    ]);
    expect(missing.results[0]?.text).toMatch(/^Saved function "runTests" was not found/);
    expect(missing.results[1]?.details.value).toEqual({ name: "runTests", removed: false });
    expect(asked).toEqual([]);

    const headless = await host({ trustProject: true }).run([save, promote]);
    expect(headless.results[1]?.isError).toBe(true);
    expect(headless.results[1]?.text).toMatch(
      /^Project function promotion requires interactive confirmation/,
    );
    const declined = await host({ trustProject: true, ui: answering(false) }).run([save, promote]);
    expect(declined.results[1]?.text).toMatch(/^Project function promotion was cancelled/);
    await expect(stat(file)).rejects.toThrow();

    const accepted = await host({ trustProject: true, ui: answering(true) }).run([
      save,
      promote,
      { code: 'async ({ functions: { remove } }) => remove("runTests")' },
    ]);
    expect(accepted.results[1]?.details.value).toEqual({
      name: "runTests",
      promoted: true,
      scope: "project",
      note: expect.stringContaining("commit it"),
    });
    expect(accepted.results[2]?.details.value).toEqual({ name: "runTests", removed: true });
    expect(asked).toEqual([
      "Save runTests to the project?",
      "Save runTests to the project?",
      "Remove project function runTests?",
    ]);
  });

  it("warns about an unreadable pit.json and summarizes many broken functions", async () => {
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "pit.json"), "{ not json");
    for (const name of ["one", "two", "three", "four"]) {
      await writeFunction(join(agentDir, "functions"), name, `async function ${name}({}) {`);
    }
    const { results } = await host().run([{ code: "async () => 1" }]);
    expect(results[0]?.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      expect.stringContaining("pit.json"),
      expect.stringMatching(/^Some saved functions could not be loaded: .*; … 1 more$/),
    ]);
  });

  it("lists models with filters and rejects what pi-durable hosts lack", async () => {
    const { results } = await host().run([
      {
        code: `async ({ models: { list, listOfType } }) => ({
          available: (await list()).models.length >= 0,
          query: (await list({ availableOnly: false, query: "FAUX", limit: 1 })).models.map((model) => model.id),
          missing: (await list({ availableOnly: false, query: "absent" })).models,
          invalid: await list({ availableOnly: "yes" as any }).catch((error: Error) => error.message),
          ofType: await listOfType("image").catch((error: Error) => error.message),
        })`,
      },
    ]);
    expect(results[0]?.details.value).toEqual({
      available: true,
      query: ["faux-model"],
      missing: [],
      invalid: "options.availableOnly must be a boolean",
      ofType: "models.listOfType is unavailable on pi-durable hosts",
    });
  });

  it("reads one completed call of a failed program by sequence", async () => {
    await writeFile(join(cwd, "data.txt"), "kept");
    const durable = host();
    const failed = await durable.run([
      {
        code: `async ({ workspace: { read } }) => {
          await read("data.txt", { format: "raw" });
          throw new Error("after the read");
        }`,
      },
    ]);
    const recovered = await durable.run([
      {
        code: "async ({ runtime: { completedCalls } }, id: string) => completedCalls(id, { sequence: 1 })",
        params: failed.results[0]?.details.recoverable.toolCallId,
      },
    ]);
    expect(recovered.results[0]?.details.value).toMatchObject({
      calls: [{ sequence: 1, call: "workspace.read" }],
    });
  });

  it("runs programs in the host's working directory override", async () => {
    const other = join(root, "other");
    await mkdir(other);
    const { results } = await host({ cwd: other }).run([
      { code: "async ({ context: { get } }) => (await get()).cwd" },
    ]);
    expect(results[0]?.details.value).toBe(other);
  });

  it("exports the generic extension factory name hosts look up", () => {
    expect(createPiDurableExtension).toBe(createPitDurableExtension);
    expect(createPiDurableExtension().tools?.map((tool) => tool.name)).toEqual(["typescript"]);
  });
});
