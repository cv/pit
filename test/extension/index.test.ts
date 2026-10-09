import { writeFile } from "node:fs/promises";

import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { validateNativeCall } from "../../src/functions/globals.js";
import { SavedFunctionService } from "../../src/functions/service.js";
import { GLOBAL_METHODS } from "../../src/index.js";
import { LIMITS } from "../../src/shared/bounds.js";
import {
  cwd,
  branchEntries,
  cleanupHarness,
  context,
  execMock,
  functionsCommand,
  run,
  runWithParams,
  sessionStart,
  sessionTree,
  setActiveTools,
  setBranchEntries,
  setupHarness,
  tool,
  toolResult,
  value,
} from "../support/extension-fixture.js";
import { png as makePng } from "../support/png-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

function imageDimensions(image: { data: string }) {
  const bytes = Buffer.from(image.data, "base64");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function hasSuccessfulViewImageTrace(result: any): boolean {
  return (
    result.details?.traces?.some(
      (trace: any) =>
        trace.namespace === "workspace" &&
        trace.method === "viewImage" &&
        trace.status === "succeeded",
    ) ?? false
  );
}

function expectNoImagePayload(value: unknown) {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toMatch(/"type"\s*:\s*"image"/);
  expect(serialized).not.toMatch(/"data"\s*:\s*"[A-Za-z0-9+/=]{64,}"/);
}

describe("pit extension", () => {
  it("registers the TypeScript tool and activates it", async () => {
    await sessionStart({}, context());
    expect(setActiveTools).toHaveBeenCalledWith(["typescript"]);
    expect((await run("async ({}) => 42")).details.value).toBe(42);
  });

  it("runs functions that declare no parameters", async () => {
    expect((await run("async () => 42")).details.value).toBe(42);
    await run("async function answer() { return 42; }");
    expect(await value("async ({ answer }) => answer()")).toBe(42);
    // Without an input parameter, params would be dropped, so validation rejects them.
    await expect(runWithParams("async () => 42", { value: 1 })).rejects.toThrow(
      "Expected 0 arguments, but got 2",
    );
  });

  it("exposes the public global-method view", () => {
    expect(GLOBAL_METHODS.shell).toEqual(["execFile", "exec"]);
    expect(GLOBAL_METHODS.gh).toContain("prView");
    expect(GLOBAL_METHODS.functions).toContain("getSaved");
  });

  it("validates native dispatch names and arity", () => {
    expect(() => validateNativeCall("context", "get", [])).not.toThrow();
    expect(() => validateNativeCall("shell", "execFile", ["git", []])).not.toThrow();
    expect(() => validateNativeCall("shell", "execFile", ["git", [], {}, 1])).toThrow(
      /expects 2-3 argument/,
    );
    expect(() => validateNativeCall("context", "get", [1])).toThrow(/expects 0 argument/);
    expect(() => validateNativeCall("workspace", "read", [])).toThrow(/expects 1-2 argument/);
    expect(() => validateNativeCall("workspace", "viewImage", [])).toThrow(/expects 1 argument/);
    expect(() => validateNativeCall("workspace", "viewImage", ["chart.png", {}])).toThrow(
      /expects 1 argument/,
    );

    expect(() => validateNativeCall("unknown", "method", [])).toThrow("Unknown host function");
  });

  it("attaches each processed image in call order without returning bytes in metadata", async () => {
    await writeFile(`${cwd}/wide.png`, makePng(32, 16));
    await writeFile(`${cwd}/small.png`, makePng(8, 4));
    const result = await run(
      `async ({ workspace: { viewImage } }) => { await Promise.all([viewImage("wide.png"), viewImage("small.png")]); }`,
    );
    const images = result.content.filter((item: any) => item.type === "image");
    expect(images.map(imageDimensions)).toEqual([
      { width: 32, height: 16 },
      { width: 8, height: 4 },
    ]);
    expect(result.details.imageAttachments).toEqual([
      expect.objectContaining({ file: "wide.png", mimeType: "image/png", omitted: false }),
      expect.objectContaining({ file: "small.png", mimeType: "image/png", omitted: false }),
    ]);
    for (const image of images) expect(JSON.stringify(result.details)).not.toContain(image.data);
    expect(result.content[0].text).toMatch(/Image: wide\.png[\s\S]*Image: small\.png/);
  });

  it("allows retry after failed image read and retains text-only model warning", async () => {
    await writeFile(`${cwd}/pixel.png`, makePng());
    const result = await run(
      `async ({ workspace: { viewImage } }) => { try { await viewImage("missing.png"); } catch {} await viewImage("pixel.png"); }`,
      context({ model: { provider: "test", id: "text-only", input: ["text"] } }),
    );
    expect(result.content.some((item: any) => item.type === "image")).toBe(true);
    expect(result.content[0].text).toContain("does not support images");
  });

  it("attaches images after a saved helper call and leaves saveOnly side-effect free", async () => {
    const definition = await tool.execute(
      "save-image-helper",
      {
        code: `async function imageHelper({ workspace: { viewImage } }) { await viewImage("pixel.png"); }`,
        saveOnly: true,
      },
      undefined,
      undefined,
      context(),
    );
    expect(definition.details.imageAttachments).toBeUndefined();
    expect(definition.content.some((item: any) => item.type === "image")).toBe(false);

    await writeFile(`${cwd}/pixel.png`, makePng());
    const result = await run(`async ({ imageHelper }) => imageHelper()`);
    expect(result.content.some((item: any) => item.type === "image")).toBe(true);
    expect(result.content[0].text).toContain("pixel.png");
  });

  it.each<{ name: string; returned: string; maxLines: number }>([
    {
      name: "large structured JSON across the byte cap",
      returned: `{ payload: "x".repeat(120000) }`,
      maxLines: LIMITS.result.maxLines,
    },
    {
      name: "many text lines across the line cap",
      returned: `Array.from({ length: 4000 }, (_, i) => String(i)).join(String.fromCharCode(10))`,
      maxLines: 4000,
    },
  ])("fits returned $name together with image notes", async ({ returned, maxLines }) => {
    await writeFile(`${cwd}/pixel.png`, makePng());
    const result = await run(
      `async ({ workspace: { viewImage } }) => { await viewImage("pixel.png"); return ${returned}; }`,
    );
    const text = result.content
      .filter((item: any) => item.type === "text")
      .map((item: any) => item.text)
      .join("\n");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(LIMITS.result.maxBytes);
    expect(text.split("\n").length).toBeLessThanOrEqual(Math.min(maxLines, LIMITS.result.maxLines));
    expect(text).toContain("Image: pixel.png");
    expect(text).toContain("Result truncated to fit");
    expect(result.content.some((item: any) => item.type === "image")).toBe(true);
  });

  it("does not leak queued images after a post-image failure", async () => {
    await writeFile(`${cwd}/pixel.png`, makePng());
    const updates: any[] = [];
    const callId = "post-image-failure";
    await expect(
      tool.execute(
        callId,
        {
          code: `async ({ workspace: { viewImage } }) => { await viewImage("pixel.png"); throw new Error("after image"); }`,
        },
        undefined,
        (update: any) => updates.push(update),
        context(),
      ),
    ).rejects.toThrow("after image");
    expect(updates.some(hasSuccessfulViewImageTrace)).toBe(true);
    expect(
      updates.every((update) => update.content.every((block: any) => block.type !== "image")),
    ).toBe(true);
    expectNoImagePayload(updates);
    const enriched = await toolResult({
      toolName: "typescript",
      toolCallId: callId,
      isError: true,
    });
    expect(enriched.content.every((block: any) => block.type === "text")).toBe(true);
    expect(enriched.details.imageAttachments).toBeUndefined();
    expectNoImagePayload(enriched);

    const ordinary = await run(`async ({}) => "ordinary after failure"`);
    expect(ordinary.details.imageAttachments).toBeUndefined();
    expect(ordinary.content.some((block: any) => block.type === "image")).toBe(false);
  });

  it("times out only after a successful image host trace and publishes no blocks", async () => {
    await writeFile(`${cwd}/pixel.png`, makePng());
    const updates: any[] = [];
    let sawImageTrace = false;
    let signalImageTrace!: () => void;
    const imageTrace = new Promise<void>((resolve) => {
      signalImageTrace = resolve;
    });
    const callId = "image-timeout";
    const execution = tool.execute(
      callId,
      {
        code: `async ({ workspace: { viewImage } }) => { await viewImage("pixel.png"); while (true) {} }`,
        timeoutMs: 750,
      },
      undefined,
      (update: any) => {
        updates.push(update);
        if (hasSuccessfulViewImageTrace(update) && !sawImageTrace) {
          sawImageTrace = true;
          signalImageTrace();
        }
      },
      context(),
    );
    const outcome = execution.then(
      () => "unexpected-success",
      () => "execution-failed",
    );
    expect(await Promise.race([imageTrace.then(() => "image-trace"), outcome])).toBe("image-trace");
    await expect(execution).rejects.toThrow();
    expect(sawImageTrace).toBe(true);
    expect(
      updates.every((update) => update.content.every((block: any) => block.type !== "image")),
    ).toBe(true);
    expectNoImagePayload(updates);
    const enriched = await toolResult({
      toolName: "typescript",
      toolCallId: callId,
      isError: true,
    });
    expect(enriched.details.failure.kind).toBe("timeout");
    expect(enriched.details.imageAttachments).toBeUndefined();
    expect(enriched.content.every((block: any) => block.type === "text")).toBe(true);
    expectNoImagePayload(enriched);
  });

  it("queues an image before commit failure without publishing or leaking it", async () => {
    await writeFile(`${cwd}/pixel.png`, makePng());
    const callId = "image-commit-failure";
    const updates: any[] = [];
    let commitReached = false;
    const commit = vi
      .spyOn(SavedFunctionService.prototype, "commit")
      .mockImplementation(async () => {
        commitReached = true;
        throw new Error("forced commit failure");
      });
    try {
      await expect(
        tool.execute(
          callId,
          {
            code: `async ({ workspace: { viewImage } }) => { await viewImage("pixel.png"); return null; }`,
          },
          undefined,
          (update: any) => {
            updates.push(update);
          },
          context(),
        ),
      ).rejects.toThrow("forced commit failure");
    } finally {
      commit.mockRestore();
    }
    expect(commitReached).toBe(true);
    expect(
      updates.every((update) => update.content.every((block: any) => block.type !== "image")),
    ).toBe(true);
    expectNoImagePayload(updates);
    const enriched = await toolResult({
      toolName: "typescript",
      toolCallId: callId,
      isError: true,
    });
    expect(enriched.details.imageAttachments).toBeUndefined();
    expect(
      enriched.details.traces.some(
        (trace: any) =>
          trace.namespace === "workspace" &&
          trace.method === "viewImage" &&
          trace.status === "succeeded",
      ),
    ).toBe(true);
    expect(enriched.content.every((block: any) => block.type === "text")).toBe(true);
    expectNoImagePayload(enriched);

    const ordinary = await run(`async ({}) => 7`);
    expect(ordinary.details.imageAttachments).toBeUndefined();
    expect(ordinary.content.some((block: any) => block.type === "image")).toBe(false);
  });

  it("keeps overlapping TypeScript invocation image bytes mapped to their source", async () => {
    await writeFile(`${cwd}/first.png`, makePng(16, 8));
    await writeFile(`${cwd}/second.png`, makePng(8, 4));
    const execute = (id: string, file: string) =>
      tool.execute(
        id,
        { code: `async ({ workspace: { viewImage } }) => viewImage("${file}")` },
        undefined,
        undefined,
        context(),
      );
    const [first, second] = await Promise.all([
      execute("first-image", "first.png"),
      execute("second-image", "second.png"),
    ]);
    const firstImage = first.content.find((block: any) => block.type === "image");
    const secondImage = second.content.find((block: any) => block.type === "image");
    expect(firstImage).toBeDefined();
    expect(secondImage).toBeDefined();
    expect(first.details.imageAttachments[0].file).toBe("first.png");
    expect(second.details.imageAttachments[0].file).toBe("second.png");
    expect(imageDimensions(firstImage)).toEqual({ width: 16, height: 8 });
    expect(imageDimensions(secondImage)).toEqual({ width: 8, height: 4 });
  });

  it("suggests project promotion once after repeated session reuse", async () => {
    await run("async function reusableWorkflow({}) { return true; }");
    for (let index = 0; index < 4; index++) {
      const result = await run("async ({ reusableWorkflow }) => reusableWorkflow()");
      expect(result.content[0].text).not.toContain("Promotion suggestion");
    }
    const threshold = await run("async ({ reusableWorkflow }) => reusableWorkflow()");
    expect(threshold.content[0].text).toContain(
      "Promotion suggestion: heavily reused session function reusableWorkflow",
    );
    expect(threshold.content[0].text).toContain("functions.promote(name, summary)");
    const repeated = await run("async ({ reusableWorkflow }) => reusableWorkflow()");
    expect(repeated.content[0].text).not.toContain("Promotion suggestion");
    await value(`async ({ functions: { removeSession } }) => removeSession("reusableWorkflow")`);
  });

  it("automatically saves and invokes named functions", async () => {
    const defined = await run(`async function greet({}, input) {
      return { greeting: "Hello, " + (input?.name ?? "world") + "!" };
    }`);
    expect(defined.details.value).toEqual({ greeting: "Hello, world!" });
    expect(defined.details.functions).toEqual([{ action: "set", name: "greet", replaced: false }]);
    expect(defined.content[0].text).toContain(
      "Inject greet in the first parameter, then call greet(input: unknown)",
    );
    expect(defined.content[0].text).toContain("[Session functions: greet(input: unknown)]");
    expect(branchEntries).toContainEqual(
      expect.objectContaining({
        type: "custom",
        customType: "pit-function-definitions",
        data: expect.objectContaining({
          name: "greet",
          source: expect.any(String),
        }),
      }),
    );

    const savedBranch = [...branchEntries];
    await value('async ({ functions: { removeSession } }) => removeSession("greet")');
    setBranchEntries(savedBranch);
    await sessionTree({}, context());
    const invoked = await run(`async ({ greet }) => greet({ name: "Pi" })`);
    expect(invoked.details.value).toEqual({ greeting: "Hello, Pi!" });
    expect(invoked.details.functions).toEqual([{ action: "run", name: "greet", scope: "session" }]);
    expect(invoked.content[0].text).toContain("[Session functions: greet(input: unknown)]");

    const replaced = await run(`async function greet({}) { return { greeting: "replaced" }; }`);
    expect(replaced.details.functions).toEqual([{ action: "set", name: "greet", replaced: true }]);
    expect(await value("async ({ greet }) => greet()")).toEqual({ greeting: "replaced" });

    await expect(
      run(`async function broken({}) { throw new Error("initial failure"); }`),
    ).rejects.toThrow("initial failure");
    await expect(
      run(`async function greet({}) { throw new Error("replacement failure"); }`),
    ).rejects.toThrow("replacement failure");
    expect(await value("async ({ greet }) => greet()")).toEqual({ greeting: "replaced" });

    const info = await value("async ({ context: { get } }) => get()");
    expect(info.savedFunctions).toEqual(["greet"]);
    expect(branchEntries.some((entry) => entry.data?.name === "broken")).toBe(false);
  });

  // The list repeated on every result: about 900 times in one long session.
  it("shows the session-function list only when it changes", async () => {
    const first = await run("async function listed({}) { return 1; }");
    expect(first.content[0].text).toContain("[Session functions: listed()]");

    const unchanged = await run("async ({ listed }) => listed()");
    expect(unchanged.content[0].text).not.toContain("[Session functions:");

    const added = await run("async function second({}) { return 2; }");
    expect(added.content[0].text).toContain("[Session functions: listed(), second()]");

    // A new session starts without the list in context.
    await sessionStart({}, context());
    const resumed = await run("async ({ second }) => second()");
    expect(resumed.content[0].text).toContain("[Session functions: listed(), second()]");
  });

  it("saves named functions without executing them", async () => {
    const source = `async function deferred({ shell: { execFile } }) {
      return execFile("node", ["--version"]);
    }`;
    const saved = await tool.execute(
      "call-id",
      { code: source, saveOnly: true },
      undefined,
      undefined,
      context(),
    );

    expect(execMock).not.toHaveBeenCalled();
    expect(saved.details.value).toEqual({ savedFunction: "deferred", executed: false });
    expect(saved.content[0].text).toContain('Saved function "deferred" without executing it');
    expect(saved.content[0].text).toContain("[Session functions: deferred()]");
    expect(branchEntries).toContainEqual(
      expect.objectContaining({
        customType: "pit-function-definitions",
        data: { name: "deferred", source: expect.any(String) },
      }),
    );

    const saveOnlyNotice = async (code: string): Promise<string> => {
      const result = await tool.execute(
        "call-id",
        { code, saveOnly: true },
        undefined,
        undefined,
        context(),
      );
      return result.content[0].text;
    };
    expect(
      await saveOnlyNotice(
        "async function requiredNotice({}, input: { value: string }) { return input.value; }",
      ),
    ).toContain(
      "Inject requiredNotice in the first parameter, then call requiredNotice(input: { value: string })",
    );
    expect(
      await saveOnlyNotice("async function optionalNotice({}, input?: number) { return input; }"),
    ).toContain(
      "Inject optionalNotice in the first parameter, then call optionalNotice(input?: number)",
    );
    expect(await saveOnlyNotice("async function noInputNotice({}) { return null; }")).toContain(
      "Inject noInputNotice in the first parameter, then call noInputNotice()",
    );

    await tool.execute(
      "call-id",
      { code: "async ({ deferred }) => deferred()" },
      undefined,
      undefined,
      context(),
    );
    expect(execMock).toHaveBeenCalledExactlyOnceWith("node", ["--version"], expect.any(Object));

    await expect(
      tool.execute(
        "call-id",
        { code: "async () => true", saveOnly: true },
        undefined,
        undefined,
        context(),
      ),
    ).rejects.toThrow("saveOnly requires a named top-level function");
    await expect(
      tool.execute(
        "call-id",
        {
          code: "async function withInput({}, input: object) { return input; }",
          params: {},
          saveOnly: true,
        },
        undefined,
        undefined,
        context(),
      ),
    ).rejects.toThrow("saveOnly does not accept top-level params");
  });

  it("rejects replacements that invalidate saved dependents", async () => {
    await run(`async function dependency({}, input: { value: number } = { value: 1 }) {
      return input.value;
    }`);
    await run(`async function dependent({ dependency }) {
      return dependency({ value: 2 });
    }`);
    const entriesBefore = branchEntries.length;

    await expect(
      run(`async function dependency(
        {},
        input: { value: string } = { value: "replacement" },
      ) { return input.value; }`),
    ).rejects.toThrow(/number.*string/);

    expect(await value("async ({ dependency }) => dependency({ value: 3 })")).toBe(3);
    expect(await value("async ({ dependent }) => dependent()")).toBe(2);
    expect(branchEntries).toHaveLength(entriesBefore);
  });

  it("names a copied elision stub instead of reporting a missing program", () => {
    // A model can imitate an elided call, with emptied arguments, or an older placeholder.
    const stub = { elided: "[Pit: the tool call arguments below were elided to save context]" };
    for (const copied of [stub, {}]) {
      expect(() => tool.prepareArguments?.(copied)).toThrow(
        "These arguments copy an elided call from context; they are not a program.",
      );
    }
    // Other arguments without code are left for schema validation to report.
    expect(tool.prepareArguments?.({ params: {} })).toEqual({ params: {} });
    expect(tool.prepareArguments?.({ code: "async () => 1", ...stub })).toMatchObject({
      code: "async () => 1",
    });
  });

  it("treats null optional arguments as omitted, as strict schema sampling sends them", async () => {
    // Pi applies prepareArguments to the raw provider arguments before validation and execution.
    const strict = (args: Record<string, unknown>) => ({
      label: null,
      functionId: null,
      params: null,
      saveOnly: null,
      timeoutMs: null,
      ...args,
    });
    const execute = (args: Record<string, unknown>) =>
      tool.execute(
        "call-id",
        tool.prepareArguments?.(args) ?? args,
        undefined,
        undefined,
        context(),
      );

    const saved = await execute(
      strict({ code: "async function strictSaved({}) { return 1; }", saveOnly: true }),
    );
    expect(saved.content[0].text).toContain("Saved function");
    expect(branchEntries.some((entry) => entry.data?.name === "strictSaved")).toBe(true);

    const anonymous = await execute(
      strict({ code: "async ({}, input?: unknown) => ({ omitted: input === undefined })" }),
    );
    expect(anonymous.details.value).toEqual({ omitted: true });
  });

  it("passes and validates top-level params as initial function input", async () => {
    const source =
      "async function inspect({}, input: { path: string }) { return { path: input.path }; }";
    const result = await runWithParams(source, { path: "README.md" });
    expect(result.details.value).toEqual({ path: "README.md" });
    expect(await value(`async ({ inspect }) => inspect({ path: "package.json" })`)).toEqual({
      path: "package.json",
    });

    await expect(
      runWithParams(source.replace("inspect", "invalidInspect"), { path: 42 }),
    ).rejects.toThrow(/number.*string/);
    expect(branchEntries.some((entry) => entry.data?.name === "invalidInspect")).toBe(false);

    const anonymous = await runWithParams(
      "async ({}, input: { value: number }) => ({ doubled: input.value * 2 })",
      { value: 21 },
    );
    expect(anonymous.details.value).toEqual({ doubled: 42 });

    // Clients that send params as a JSON string still reach typed inputs.
    const decoded = await runWithParams(
      "async ({}, input: { value: number }) => ({ doubled: input.value * 2 })",
      JSON.stringify({ value: 21 }),
    );
    expect(decoded.details.value).toEqual({ doubled: 42 });
    const named = await runWithParams(
      source.replace("inspect", "encodedInspect"),
      JSON.stringify({ path: "README.md" }),
    );
    expect(named.details.value).toEqual({ path: "README.md" });
    const literal = await runWithParams("async ({}, input: string) => input", '{"value":21}');
    expect(literal.details.value).toBe('{"value":21}');
    await expect(runWithParams("inspect()", {})).rejects.toThrow(
      "TypeScript programs must be function expressions",
    );
  });

  it("does not render injected saved-function sources", async () => {
    await run("async function baseTask({}) { return { value: 1 }; }");
    await run(
      "async function composedTask({ baseTask }) { const base = await baseTask(); return { value: base.value + 1 }; }",
    );
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const expanded =
      tool
        .renderCall?.({ code: "async ({ composedTask }) => composedTask()" }, theme, {
          expanded: true,
          argsComplete: true,
        })
        .render(240)
        .join("\n") ?? "";

    expect(expanded).toContain("Run composedTask");
    expect(expanded).not.toContain("saved dependency:");
    expect(expanded).not.toContain("saved function:");
    expect(expanded).not.toContain("async function baseTask");
  });

  it("allows saved functions to call one another", async () => {
    await value("async function base({}, input) { return { value: (input?.value ?? 0) * 2 }; }");
    await value(`async function composed({ base }, input) {
      const result = await base(input);
      return { value: result.value + 1 };
    }`);
    expect(await value("async ({ composed }) => composed({ value: 20 })")).toEqual({ value: 41 });
  });

  it("persists named functions on the active session branch", async () => {
    await value("async function persistent({}) { return { ok: true }; }");
    await sessionStart({}, context());
    const reloaded = await run("async ({ persistent }) => persistent()");
    expect(reloaded.details.value).toEqual({ ok: true });
    expect(reloaded.content[0].text).toContain("[Session functions: persistent()]");

    const previousBranch = [...branchEntries];
    setBranchEntries([]);
    sessionTree({}, context());
    await expect(run("async ({ persistent }) => persistent()")).rejects.toThrow(
      /Property 'persistent' does not exist/,
    );

    setBranchEntries(previousBranch);
    sessionTree({}, context());
    const restored = await run("async ({ persistent }) => persistent()");
    expect(restored.details.value).toEqual({ ok: true });
    expect(restored.content[0].text).toContain("[Session functions: persistent()]");
  });

  it("handles empty, missing, non-TUI, and cancelled function management", async () => {
    const nonTui = context();
    await functionsCommand.handler("", nonTui);
    expect(nonTui.ui.notify).toHaveBeenCalledWith(expect.stringContaining("[global]"), "info");
    await functionsCommand.handler("show missing", nonTui);
    expect(nonTui.ui.notify).toHaveBeenCalledWith(`function "missing" is unavailable`, "error");

    const tui = context({ mode: "tui" });
    await functionsCommand.handler("", tui);
    expect(tui.ui.select).toHaveBeenCalledWith(
      "Functions",
      expect.arrayContaining([expect.stringContaining("[global]")]),
    );

    await run("async function solo({}) { return true; }");
    await functionsCommand.handler("show solo", nonTui);
    expect(nonTui.ui.notify).toHaveBeenCalledWith("Function inspection requires TUI mode", "error");

    const entriesBeforeCancellation = branchEntries.length;
    nonTui.ui.confirm = vi.fn(async () => false);
    await functionsCommand.handler("delete solo", nonTui);
    expect((await value("async ({ context: { get } }) => get()")).savedFunctions).toEqual(["solo"]);
    expect(branchEntries).toHaveLength(entriesBeforeCancellation);
    nonTui.ui.confirm = vi.fn(async () => true);
    await functionsCommand.handler("delete solo", nonTui);
    expect((await value("async ({ context: { get } }) => get()")).savedFunctions).toEqual([]);
    expect(nonTui.ui.notify).toHaveBeenCalledWith("Deleted saved function: solo", "info");
  });

  it("lists and deletes saved functions through the /functions command", async () => {
    await run("async function baseTask({}) { return 1; }");
    await run("async function composedTask({ baseTask }) { return (await baseTask()) + 1; }");
    await run(
      "async function transitiveTask({ composedTask }) { return (await composedTask()) + 1; }",
    );
    const ctx = context();

    await functionsCommand.handler("list", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("baseTask"), "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("composedTask"), "info");

    await functionsCommand.handler("delete baseTask", ctx);
    expect(ctx.ui.confirm).toHaveBeenCalledWith(
      "Delete baseTask?",
      expect.stringMatching(
        /Also delete dependents: composedTask, transitiveTask\nDirect: composedTask\nTransitive: transitiveTask/,
      ),
    );
    expect(branchEntries).toContainEqual(
      expect.objectContaining({
        customType: "pit-function-definitions",
        data: { name: "baseTask", deleted: true },
      }),
    );
    expect(branchEntries).toContainEqual(
      expect.objectContaining({
        customType: "pit-function-definitions",
        data: { name: "composedTask", deleted: true },
      }),
    );
    expect(branchEntries).toContainEqual(
      expect.objectContaining({
        customType: "pit-function-definitions",
        data: { name: "transitiveTask", deleted: true },
      }),
    );
    expect((await value("async ({ context: { get } }) => get()")).savedFunctions).toEqual([]);

    await functionsCommand.handler("delete missing", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(`Saved function "missing" was not found`, "error");
    await functionsCommand.handler("unknown", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage: /functions"),
      "error",
    );
  });

  it("inspects saved source and drives the interactive /functions manager", async () => {
    await run(`async function inspectMe({}) {
      /* first
      second */
      return { ok: true };
    }`);
    const ctx = context({ mode: "tui" });
    let rendered = "";
    ctx.ui.custom = vi.fn(async (factory?: any) => {
      if (!factory) {
        return;
      }
      let closed = false;
      const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
      initTheme("dark");
      const component = factory({}, theme, {}, () => {
        closed = true;
      });
      const darkRendered = component.render(120).join("\n");
      initTheme("light");
      component.invalidate();
      rendered = component.render(120).join("\n");
      expect(rendered).not.toBe(darkRendered);
      component.handleInput("x");
      expect(closed).toBe(false);
      component.handleInput("\r");
      expect(closed).toBe(true);
      component.handleInput("\u001b");
      component.handleInput("\u0003");
      component.handleInput("q");
    });

    await functionsCommand.handler("show inspectMe", ctx);
    expect(rendered).toContain("inspectMe");
    expect(stripTerminalSequences(rendered)).toContain("async function inspectMe");

    const continuedComment = rendered.split("\n").find((line) => line.includes("second */")) ?? "";
    expect(continuedComment.slice(0, continuedComment.indexOf("second */"))).toContain("\u001b[");

    const longSource = Array.from(
      { length: 505 },
      (_, index) => `// viewer line ${index + 1}`,
    ).join("\n");
    await run(`async function longViewer({}) {\n${longSource}\nreturn true;\n}`);
    await functionsCommand.handler("show longViewer", ctx);
    expect(rendered).toContain("source lines omitted");

    ctx.ui.select = vi
      .fn()
      .mockImplementationOnce(async (_title: string, options: string[]) => options[0])
      .mockResolvedValueOnce("Inspect source")
      .mockImplementationOnce(async (_title: string, options: string[]) => options[0])
      .mockResolvedValueOnce("Close");
    await functionsCommand.handler("", ctx);
    expect(ctx.ui.select).toHaveBeenCalledWith(
      "Functions",
      expect.arrayContaining([expect.stringContaining("inspectMe")]),
    );
    expect(ctx.ui.custom).toHaveBeenCalledTimes(3);

    ctx.ui.select = vi.fn().mockResolvedValueOnce("not an entry");
    await functionsCommand.handler("", ctx);
    ctx.ui.select = vi.fn().mockResolvedValueOnce(undefined);
    await functionsCommand.handler("", ctx);

    ctx.ui.select = vi
      .fn()
      .mockImplementationOnce(async (_title: string, options: string[]) => options[0])
      .mockResolvedValueOnce(undefined);
    await functionsCommand.handler("", ctx);

    ctx.ui.select = vi
      .fn()
      .mockImplementationOnce(async (_title: string, options: string[]) =>
        options.find((option) => option.startsWith("longViewer")),
      )
      .mockResolvedValueOnce("Delete")
      .mockResolvedValueOnce(undefined);
    await functionsCommand.handler("", ctx);
    expect((await value("async ({ context: { get } }) => get()")).savedFunctions).toEqual([
      "inspectMe",
    ]);
  });

  it("rejects reserved, oversized, and unknown saved functions", async () => {
    await expect(run("async function Promise({}) { return null; }")).rejects.toThrow(
      "non-reserved TypeScript identifier",
    );
    const oversized = `async function enormous({}) { /*${"x".repeat(100_001)}*/ return null; }`;
    await expect(run(oversized)).rejects.toThrow("saved function source exceeds");
    await expect(run("async ({ missingFunction }) => missingFunction()")).rejects.toThrow(
      /Property 'missingFunction' does not exist/,
    );
    await expect(
      run(`async (dependencies) => (dependencies as any).__pit.savedFunctionRun("missing")`),
    ).rejects.toThrow("object first parameter");
  });
  it("preserves structured context for failed saved functions", async () => {
    await run(`async function failureLeaf({}, input: { fail?: boolean } = {}) {
      if (input.fail) throw new Error("boom");
      return true;
    }`);
    await run(`async function failureOuter({ failureLeaf }, input: { fail?: boolean } = {}) {
      return failureLeaf(input);
    }`);

    await expect(
      tool.execute(
        "failure-id",
        { code: "async ({ failureOuter }) => failureOuter({ fail: true })" },
        undefined,
        undefined,
        context(),
      ),
    ).rejects.toThrow("boom");
    const enriched = await toolResult({
      toolName: "typescript",
      toolCallId: "failure-id",
      isError: true,
      content: [{ type: "text", text: "wrapped" }],
    });
    expect(enriched.content).toEqual([{ type: "text", text: "boom" }]);
    expect(enriched.details.failure).toEqual({
      functionPath: ["failureOuter", "failureLeaf"],
      rootError: "boom",
      kind: "user",
    });
    expect(enriched.details.functions).toEqual([
      { action: "run", name: "failureOuter", scope: "session" },
      { action: "run", name: "failureLeaf", scope: "session" },
    ]);
    expect(enriched.details.traces.length).toBeGreaterThan(0);

    await value(`async ({ functions: { removeSession } }) => removeSession("failureOuter")`);
    await value(`async ({ functions: { removeSession } }) => removeSession("failureLeaf")`);
  });
});
