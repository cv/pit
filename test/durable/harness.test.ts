import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolRegistration } from "@earendil-works/pi-durable";
import { DEFAULT_IMAGE_LIMITS } from "@earendil-works/pi-durable/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPiDurableExtension,
  createPitDurableExtension,
  type PitDurableOptions,
} from "../../src/durable/index.js";
import { DurableTestHost } from "../support/durable-harness.js";
import { png } from "../support/png-fixture.js";

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
    ["session.compact", "async ({ session: { compact } }) => compact()"],
    ["session.setName", 'async ({ session: { setName } }) => setName("issue 7")'],
    ["models.set", 'async ({ models: { set } }) => set("faux", "faux-model")'],
  ])("reports %s as unavailable on pi-durable hosts", async (global, code) => {
    const { results } = await host().run([{ code }]);
    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.text).toMatch(new RegExp(`^${global} is unavailable on pi-durable hosts`));
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
    expect(sections.pit_guidelines).toContain("session.setNote");
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
    expect(results[0]?.text).toContain("\nImage: chart\nReturned by chart");
    expect(results[0]?.text).toContain("\nImage: photo\nReturned by photo");
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

describe("images on pi-durable hosts", () => {
  const view = (file: string) => ({
    code: `async ({ workspace: { viewImage } }) => viewImage(${JSON.stringify(file)})`,
  });

  /** The image blocks of the tool results the model's requests carried. */
  function sentImages(requests: any[][]): Array<{ data: string; mimeType: string }> {
    const last = requests.at(-1) ?? [];
    return last
      .filter((message) => message.role === "toolResult")
      .flatMap((message) => message.content)
      .filter((block: any) => block.type === "image")
      .map(({ data, mimeType }: any) => ({ data, mimeType }));
  }

  it("attaches a viewed image to the result the model receives", async () => {
    const bytes = png();
    await writeFile(join(cwd, "shot.png"), bytes);
    const { results, requests } = await host().run([view("shot.png")]);
    expect(results[0]?.isError).toBe(false);
    expect(results[0]?.details.value).toEqual({
      file: "shot.png",
      mimeType: "image/png",
      queued: true,
    });
    expect(results[0]?.text).toContain("\nImage: shot.png\nRead image file [image/png].");
    expect(results[0]?.details.imageAttachments).toEqual([
      expect.objectContaining({ file: "shot.png", omitted: false }),
    ]);
    expect(sentImages(requests)).toEqual([
      { data: bytes.toString("base64"), mimeType: "image/png" },
    ]);
  });

  it("says a text-only model is not shown the image", async () => {
    await writeFile(join(cwd, "shot.png"), png());
    const textOnly = new DurableTestHost({
      extension: createPitDurableExtension({ agentDir }),
      cwd,
      model: { input: ["text"] },
    });
    const { results } = await textOnly.run([view("shot.png")]);
    expect(results[0]?.text).toContain(
      "The current model does not support images; it is left out of its requests.",
    );
    expect(results[0]?.details.imageAttachments).toEqual([
      expect.objectContaining({ file: "shot.png", omitted: true }),
    ]);
  });

  it("recognizes images by their magic bytes and passes inline formats through", async () => {
    const riff = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);
    await Promise.all([
      writeFile(join(cwd, "a.gif"), Buffer.from("GIF89a\u0001\u0000\u0001\u0000")),
      writeFile(join(cwd, "b.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])),
      writeFile(join(cwd, "c.webp"), riff),
      writeFile(join(cwd, "d.gif"), Buffer.from("GIF87a\u0001\u0000\u0001\u0000")),
    ]);
    const { results } = await host().run([
      {
        code: `async ({ workspace: { viewImage } }) =>
          Promise.all(["a.gif", "b.jpg", "c.webp", "d.gif"].map(async (file) => (await viewImage(file)).mimeType))`,
      },
    ]);
    expect(results[0]?.details.value).toEqual([
      "image/gif",
      "image/jpeg",
      "image/webp",
      "image/gif",
    ]);
  });

  it("refuses files it cannot attach without an image processor", async () => {
    const bmp = Buffer.concat([Buffer.from("BM"), Buffer.alloc(40)]);
    const large = Buffer.concat([png().subarray(0, 8), Buffer.alloc(4 * 1024 * 1024)]);
    await Promise.all([
      writeFile(join(cwd, "a.bmp"), bmp),
      writeFile(join(cwd, "notes.txt"), "not an image"),
      writeFile(join(cwd, "large.png"), large),
    ]);
    const { results } = await host().run([
      {
        code: `async ({ workspace: { viewImage } }) =>
          Promise.all(["a.bmp", "notes.txt", "large.png"].map((file) =>
            viewImage(file).catch((error: Error) => error.message)))`,
      },
    ]);
    expect(results[0]?.details.value).toEqual([
      "a.bmp is an image (image/bmp) that needs converting, and the host configured no image processor",
      "Not a supported image: notes.txt",
      "large.png is too large to attach, and the host configured no image processor to shrink it",
    ]);
  });

  it("prepares images with the host's processor within the model's limits", async () => {
    await writeFile(join(cwd, "a.bmp"), Buffer.concat([Buffer.from("BM"), Buffer.alloc(40)]));
    await writeFile(join(cwd, "broken.png"), png().subarray(0, 12));
    const prepare = vi.fn(async (bytes: Uint8Array, mimeType: string) =>
      mimeType === "image/bmp"
        ? {
            data: "aGk=",
            mimeType: "image/png",
            convertedFrom: "image/bmp",
            resized: { from: { width: 4000, height: 2000 }, to: { width: 2000, height: 1000 } },
          }
        : undefined,
    );
    const { results, requests } = await host({ images: { prepare } }).run([
      {
        code: `async ({ workspace: { viewImage } }) => ({
          bmp: await viewImage("a.bmp"),
          broken: await viewImage("broken.png").catch((error: Error) => error.message),
        })`,
      },
    ]);
    expect(prepare).toHaveBeenCalledWith(expect.any(Uint8Array), "image/bmp", DEFAULT_IMAGE_LIMITS);
    expect(results[0]?.details.value).toEqual({
      bmp: { file: "a.bmp", mimeType: "image/png", queued: true },
      broken: "Unable to prepare image for the model: broken.png",
    });
    expect(results[0]?.text).toContain(
      "Read image file [image/png]. Converted from image/bmp to image/png. Resized from 4000x2000 to 2000x1000. Multiply coordinates by 2.00 to map them to the original.",
    );
    expect(sentImages(requests)).toEqual([{ data: "aGk=", mimeType: "image/png" }]);
  });

  it("applies the model's resize profile, capped at the encoded limit images have on Pi", async () => {
    await writeFile(join(cwd, "shot.png"), png());
    const prepare = vi.fn(async () => ({ data: "aGk=", mimeType: "image/png" }));
    const limited = new DurableTestHost({
      extension: createPitDurableExtension({ agentDir, images: { prepare } }),
      cwd,
      model: { inputLimits: { images: { resize: { maxWidth: 800, maxBytes: 64 * 1024 * 1024 } } } },
    });
    await limited.run([view("shot.png")]);
    expect(prepare).toHaveBeenCalledWith(expect.any(Uint8Array), "image/png", {
      maxWidth: 800,
      maxHeight: DEFAULT_IMAGE_LIMITS.maxHeight,
      maxBytes: 5 * 1024 * 1024,
    });
  });

  it("attaches images that a tool with an output schema returns to programs", async () => {
    const snap: ToolRegistration = {
      name: "snap",
      description: "Takes a snapshot.",
      parameters: { type: "object", properties: {} },
      structuredOutputSchema: {
        type: "object",
        properties: {
          type: { type: "string" },
          data: { type: "string" },
          mimeType: { type: "string" },
        },
        required: ["type", "data", "mimeType"],
      },
      execute: async () => {
        const image = { type: "image" as const, data: "aGk=", mimeType: "image/png" };
        return { output: [image], structuredOutput: image };
      },
    };
    const { results, requests } = await host({}, [snap]).run([
      { code: "async ({ tools: { snap } }) => (await snap()).mimeType" },
    ]);
    expect(results[0]?.details.value).toBe("image/png");
    expect(results[0]?.text).toContain("\nImage: snap\nReturned by snap");
    expect(sentImages(requests)).toEqual([{ data: "aGk=", mimeType: "image/png" }]);
  });
});
