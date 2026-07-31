import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAPABILITY_REGISTRY,
  generateCapabilityContract,
  validateCapabilityCall,
} from "../src/capability-registry.js";
import {
  CAPABILITY_METHODS,
  display,
  reconstructFunctions,
  validateRegistryCapacity,
} from "../src/index.js";
import {
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
  value,
} from "./extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

describe("function registry handler", () => {
  it("bounds saved function count and aggregate source size", () => {
    expect(() => validateRegistryCapacity(new Map(), "large", "x".repeat(100_001))).toThrow(
      "saved function source exceeds",
    );

    const full = new Map(Array.from({ length: 64 }, (_, index) => [`fn${index}`, "x"]));
    expect(() => validateRegistryCapacity(full, "extra", "x")).toThrow("limited to 64 functions");
    expect(() => validateRegistryCapacity(full, "fn0", "replacement")).not.toThrow();

    const aggregate = new Map(
      Array.from({ length: 10 }, (_, index) => [`fn${index}`, "x".repeat(100_000)]),
    );
    expect(() => validateRegistryCapacity(aggregate, "fn0", "x".repeat(100_000))).not.toThrow();
    expect(() => validateRegistryCapacity(aggregate, "extra", "x")).toThrow(
      "exceeds 976.6KB total source",
    );
  });
  it("reconstructs valid branch-local function mutations", () => {
    const functions = new Map<string, string>();
    const source = `() => "saved"`;
    reconstructFunctions(functions, [
      null,
      { type: "custom", customType: "other", data: {} },
      { type: "custom", customType: "pit-functions", data: null },
      { type: "custom", customType: "pit-functions", data: { name: "bad name", source } },
      { type: "custom", customType: "pit-functions", data: { name: 42, source } },
      { type: "custom", customType: "pit-functions", data: { name: "missing-source", source: 42 } },
      { type: "custom", customType: "pit-functions", data: { name: "stale", source: "() => 1n" } },
      { type: "custom", customType: "pit-functions", data: { name: "active", source } },
      { type: "custom", customType: "pit-functions", data: { name: "active", deleted: true } },
      { type: "custom", customType: "pit-functions", data: { name: "remaining", source } },
    ]);
    expect([...functions.keys()]).toEqual(["remaining"]);
  });
});

describe("display", () => {
  it("falls back when a value cannot be stringified", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(display(circular)).toBe("[object Object]");
  });
});

describe("pit extension", () => {
  it("registers clear model-facing usage metadata and activates the tool", () => {
    expect(tool.label).toBe("TypeScript Workspace");
    expect(tool.promptSnippet).toContain("reusable functions");
    expect(tool.description).toContain("async ({ workspace, shell })");
    expect(tool.description).toContain("Promise.all");
    expect(tool.description).toContain("Promise.allSettled");
    expect(tool.description).toContain("contextually type-checked");
    expect(tool.description).toContain("defaults to hashed line:hash anchors");
    expect(tool.description).toContain("Nonzero exits are data by default");
    expect(tool.description).toContain("workspace.search(query");
    expect(tool.description).toContain("shell.execFile(program, args");
    expect(tool.description).toContain("contextLines?: 0..10");
    expect(tool.description).toContain("limit?: 1..500");
    expect(tool.description).toContain("changes: { revision, changes }");
    expect(tool.description).toContain('insertBefore/insertAfter use "anchor"');
    expect(tool.description).toContain("cwd?, timeoutMs?, raise?");
    expect(tool.description).toContain("runTests({ coverage: true })");
    expect(tool.description).toContain("REUSABLE AND COMPOSED FUNCTIONS");
    expect(tool.description).toContain(
      "Use an anonymous function only for genuinely one-shot work",
    );
    expect(tool.description.indexOf("CALLING CONTRACT")).toBeLessThan(
      tool.description.indexOf("REUSABLE AND COMPOSED FUNCTIONS"),
    );
    expect(tool.description).toContain("publishChanges");
    expect(tool.description).toContain("active saved-function signatures");
    expect(tool.description).toContain("HASHED EDIT WORKFLOW");
    expect(tool.description).toContain('kind: "replace"');
    expect(tool.description).toContain("replaceFile");
    expect(tool.description).toContain("missing totalLines means lines");
    expect(tool.description).toContain("discard every prior revision and anchor");
    expect(tool.description).toContain("never mutate the same file concurrently");
    expect(tool.description).toContain('kind: "read", file, options?');
    expect(tool.description).toContain("only after successful execution");
    expect(tool.description).toContain("Save functions aggressively");
    expect(tool.description).toContain("do not wait for exact repetition");
    expect(tool.parameters.properties.code.description).toContain("named function definition");
    expect(tool.parameters.properties.code.description).toContain("do not import");
    expect(tool.parameters.properties.params.description).toContain("second argument");
    expect(tool.parameters.properties.params.description).toContain("file contents");
    expect(tool.parameters.properties.timeoutMs.description).toContain("30000");
    expect(tool.parameters.properties.saveOnly.description).toContain("without executing");
    expect(tool.promptGuidelines).toHaveLength(8);
    expect(tool.promptGuidelines?.join("\n")).toContain("one tool invocation per step");
    expect(tool.promptGuidelines?.join("\n")).toContain(
      "instead of issuing multiple parallel typescript calls",
    );
    expect(tool.promptGuidelines?.join("\n")).toContain("only the fields and record limits");
    expect(tool.promptGuidelines?.join("\n")).toContain("expand the query only");
    expect(tool.promptGuidelines?.join("\n")).toContain("successful edit invalidates");
    expect(tool.promptGuidelines?.join("\n")).toContain("re-read before the next edit");
    expect(tool.promptGuidelines?.join("\n")).toContain("as soon as work repeats");
    expect(tool.promptGuidelines?.join("\n")).toContain("likely to recur");
    expect(tool.promptGuidelines?.join("\n")).toContain("truly ad hoc work");
    expect(tool.promptGuidelines?.every((guideline) => guideline.includes("typescript"))).toBe(
      true,
    );
    const metadataChars =
      tool.description.length +
      (tool.promptSnippet?.length ?? 0) +
      (tool.promptGuidelines?.join("\n").length ?? 0) +
      (tool.parameters.properties.code.description?.length ?? 0) +
      (tool.parameters.properties.params.description?.length ?? 0);
    expect(metadataChars).toBeLessThan(6500);

    sessionStart({}, context());
    expect(setActiveTools).toHaveBeenCalledWith(["typescript"]);
  });

  it("keeps capability declarations and model-facing metadata in sync", async () => {
    const contract = await readFile(join(process.cwd(), "src/capability-contract.d.ts"), "utf8");
    const readme = await readFile(join(process.cwd(), "README.md"), "utf8");
    expect(contract).toBe(generateCapabilityContract());

    for (const [capability, methods] of Object.entries(CAPABILITY_METHODS)) {
      const interfaceName =
        CAPABILITY_REGISTRY[capability as keyof typeof CAPABILITY_REGISTRY].interfaceName;
      const pattern = new RegExp(`interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`);
      const body = contract.match(pattern)?.[1] ?? "";
      const declared = [...body.matchAll(/^ {2}([A-Za-z_$][\w$]*)\(/gm)].map((match) => match[1]);
      expect(declared, capability).toEqual([...methods]);
      for (const method of methods) {
        const qualified = `${capability}.${method}`;
        expect(tool.description, `metadata for ${qualified}`).toContain(qualified);
        expect(readme, `README for ${qualified}`).toContain(`\`${method}(`);
      }
    }
  });

  it("validates capability dispatch and arity from the registry", () => {
    expect(() => validateCapabilityCall("context", "get", [])).not.toThrow();
    expect(() => validateCapabilityCall("context", "get", [1])).toThrow(/expects 0 argument/);
    expect(() => validateCapabilityCall("workspace", "read", [])).toThrow(/expects 1-2 argument/);
    expect(() => validateCapabilityCall("unknown", "method", [])).toThrow(
      "Unknown capability or method",
    );
  });

  it("renders generated TypeScript source with collapsed and expanded views", () => {
    const code = Array.from({ length: 15 }, (_, index) => `// source line ${index + 1}`).join("\n");
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const render = (args: any, context: any) =>
      tool.renderCall?.(args, theme, context).render(200).join("\n") ?? "";

    const collapsed = render({ code, timeoutMs: 5000 }, { expanded: false, argsComplete: true });
    expect(collapsed).toContain("typescript (15 lines) timeout=5000ms");
    expect(collapsed).toContain("source line 1");
    expect(collapsed).not.toContain("source line 15");
    expect(collapsed).toContain("3 more lines (Ctrl+O to expand)");

    const expanded = render({ code }, { expanded: true, argsComplete: true });
    expect(expanded).toContain("source line 15");
    expect(expanded).not.toContain("more lines");

    const singleLine = render({ code: "return 1" }, { expanded: false, argsComplete: true });
    expect(singleLine).toContain("1 line)");

    const saveOnly = render(
      { code: "async function later() {}", saveOnly: true },
      { expanded: false, argsComplete: true },
    );
    expect(saveOnly).toContain("save-only");

    const empty = render({ code: "" }, { expanded: false, argsComplete: true });
    expect(empty).toContain("empty source");

    const partial = render({ code: undefined }, { expanded: false, argsComplete: false });
    expect(partial).toContain("generating…");
    expect(partial).toContain("waiting for source…");
  });

  it("renders result values as highlighted JSON", () => {
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const render = (result: any, options: any, context: any = { isError: false }) =>
      tool.renderResult?.(result, options, theme, context).render(200).join("\n") ?? "";
    const value = Object.fromEntries(
      Array.from({ length: 15 }, (_, index) => [`key${index + 1}`, index + 1]),
    );
    const result = {
      content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
      details: {
        value,
        truncated: false,
        functions: [
          { action: "set", name: "test", replaced: false },
          { action: "set", name: "test", replaced: true },
          { action: "run", name: "test" },
        ],
      },
    };

    const collapsed = render(result, { expanded: false, isPartial: false });
    expect(collapsed).toContain("functions: saved test, replaced test, ran test");
    expect(collapsed).toContain("result (17 lines)");
    expect(collapsed).toContain('"key1"');
    expect(collapsed).not.toContain('"key15"');
    expect(collapsed).toContain("5 more lines (Ctrl+O to expand)");

    const expanded = render(result, { expanded: true, isPartial: false });
    expect(expanded).toContain('"key15"');
    expect(expanded).not.toContain("more lines");

    const stringResult = render(
      { content: [{ type: "text", text: "hello" }], details: { value: "hello", truncated: false } },
      { expanded: false, isPartial: false },
    );
    expect(stringResult).toContain('"hello"');
    expect(stringResult).toContain("1 line)");

    const undefinedResult = render(
      {
        content: [{ type: "text", text: "undefined" }],
        details: { value: undefined, truncated: false },
      },
      { expanded: false, isPartial: false },
    );
    expect(undefinedResult).toContain("undefined");

    const truncated = render(
      {
        content: [{ type: "text", text: "partial output" }],
        details: { value: undefined, truncated: true },
      },
      { expanded: false, isPartial: false },
    );
    expect(truncated).toContain("result (truncated)");
    expect(truncated).toContain("partial output");

    const empty = render(
      { content: [], details: undefined },
      { expanded: false, isPartial: false },
    );
    expect(empty).toContain("no result");

    const partial = render(
      { content: [], details: undefined },
      { expanded: false, isPartial: true },
    );
    expect(partial).toContain("Running TypeScript…");

    const streaming = render(
      {
        content: [{ type: "text", text: "Running TypeScript…" }],
        details: {
          value: undefined,
          truncated: false,
          progress: [
            { id: 1, command: "npm test", status: "running", output: "test output" },
            { id: 2, command: "git status", status: "done", code: 0, output: "clean" },
            { id: 3, command: "sleep 1", status: "running", output: "" },
          ],
        },
      },
      { expanded: false, isPartial: true },
    );
    expect(streaming).toContain("[running] npm test");
    expect(streaming).toContain("test output");
    expect(streaming).toContain("[done (0)] git status");
    expect(streaming).toContain("[running] sleep 1");

    const symbolResult = render(
      { content: [], details: { value: Symbol("value"), truncated: false } },
      { expanded: false, isPartial: false },
    );
    expect(symbolResult).toContain("Symbol(value)");

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const circularResult = render(
      { content: [], details: { value: circular, truncated: false } },
      { expanded: false, isPartial: false },
    );
    expect(circularResult).toContain("[object Object]");

    const error = render(
      { content: [{ type: "text", text: "bad code" }] },
      { expanded: false, isPartial: false },
      { isError: true },
    );
    expect(error).toContain("bad code");
    expect(
      render({ content: [] }, { expanded: false, isPartial: false }, { isError: true }),
    ).toContain("TypeScript execution failed");
  });

  it("automatically saves and invokes named functions", async () => {
    const defined = await run(`async function greet(_capabilities, input) {
      return { greeting: "Hello, " + (input?.name ?? "world") + "!" };
    }`);
    expect(defined.details.value).toEqual({ greeting: "Hello, world!" });
    expect(defined.details.functions).toEqual([{ action: "set", name: "greet", replaced: false }]);
    expect(defined.content[0].text).toContain("Invoke later with: greet()");
    expect(defined.content[0].text).toContain("[Saved functions: greet(input: unknown)]");
    expect(branchEntries).toContainEqual(
      expect.objectContaining({
        type: "custom",
        customType: "pit-functions",
        data: expect.objectContaining({
          name: "greet",
          source: expect.stringContaining("function greet"),
        }),
      }),
    );

    const invoked = await run(`greet({ name: "Pi" })`);
    expect(invoked.details.value).toEqual({ greeting: "Hello, Pi!" });
    expect(invoked.details.functions).toEqual([{ action: "run", name: "greet" }]);
    expect(invoked.content[0].text).toContain("[Saved functions: greet(input: unknown)]");

    const replaced = await run(`async function greet() { return { greeting: "replaced" }; }`);
    expect(replaced.details.functions).toEqual([{ action: "set", name: "greet", replaced: true }]);
    expect(await value("greet()")).toEqual({ greeting: "replaced" });

    await expect(
      run(`async function broken() { throw new Error("initial failure"); }`),
    ).rejects.toThrow("initial failure");
    await expect(
      run(`async function greet() { throw new Error("replacement failure"); }`),
    ).rejects.toThrow("replacement failure");
    expect(await value("greet()")).toEqual({ greeting: "replaced" });

    const info = await value("async ({ context }) => context.get()");
    expect(info.savedFunctions).toEqual(["greet"]);
    expect(branchEntries.some((entry) => entry.data?.name === "broken")).toBe(false);
  });

  it("saves named functions without executing them", async () => {
    const source = `async function deferred({ shell }) {
      return shell.execFile("node", ["--version"]);
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
    expect(saved.content[0].text).toContain("[Saved functions: deferred()]");
    expect(branchEntries).toContainEqual(
      expect.objectContaining({
        customType: "pit-functions",
        data: { name: "deferred", source },
      }),
    );

    await run("deferred()");
    expect(execMock).toHaveBeenCalledOnce();

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
          code: "async function withInput(_capabilities, input: object) { return input; }",
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
    await run(`async function dependency(_capabilities, input: { value: number } = { value: 1 }) {
      return input.value;
    }`);
    await run(`async function dependent() {
      return dependency({ value: 2 });
    }`);
    const entriesBefore = branchEntries.length;

    await expect(
      run(`async function dependency(
        _capabilities,
        input: { value: string } = { value: "replacement" },
      ) { return input.value; }`),
    ).rejects.toThrow(/number.*string/);

    expect(await value("dependency({ value: 3 })")).toBe(3);
    expect(await value("dependent()")).toBe(2);
    expect(branchEntries).toHaveLength(entriesBefore);
  });

  it("passes and validates top-level params as initial function input", async () => {
    const source =
      "async function inspect(_capabilities, input: { path: string }) { return { path: input.path }; }";
    const result = await runWithParams(source, { path: "README.md" });
    expect(result.details.value).toEqual({ path: "README.md" });
    expect(await value(`inspect({ path: "package.json" })`)).toEqual({ path: "package.json" });

    await expect(
      runWithParams(source.replace("inspect", "invalidInspect"), { path: 42 }),
    ).rejects.toThrow(/number.*string/);
    expect(branchEntries.some((entry) => entry.data?.name === "invalidInspect")).toBe(false);

    const anonymous = await runWithParams(
      "async (_capabilities, input: { value: number }) => ({ doubled: input.value * 2 })",
      { value: 21 },
    );
    expect(anonymous.details.value).toEqual({ doubled: 42 });
    await expect(runWithParams("inspect()", {})).rejects.toThrow(
      "Top-level params can only be passed to a function expression",
    );
  });

  it("renders injected saved functions and dependencies in expanded calls", async () => {
    await run("async function baseTask() { return { value: 1 }; }");
    await run(
      "async function composedTask() { const base = await baseTask(); return { value: base.value + 1 }; }",
    );
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const render = (expanded: boolean) =>
      tool
        .renderCall?.({ code: "composedTask()" }, theme, { expanded, argsComplete: true })
        .render(240)
        .join("\n") ?? "";

    const collapsed = render(false);
    expect(collapsed).toContain("uses saved: baseTask, composedTask");
    expect(collapsed).not.toContain("saved function: composedTask");

    const expanded = render(true);
    expect(expanded).toContain("saved dependency: baseTask");
    expect(expanded).toContain("async function baseTask");
    expect(expanded).toContain("saved function: composedTask");
    expect(expanded).toContain("async function composedTask");

    const comments = Array.from({ length: 205 }, (_, index) => `// source line ${index + 1}`).join(
      "\n",
    );
    await run(`async function longTask() {\n${comments}\nreturn true;\n}`);
    const longOutput =
      tool
        .renderCall?.({ code: "longTask()" }, theme, { expanded: true, argsComplete: true })
        .render(240)
        .join("\n") ?? "";
    expect(longOutput).toContain("source lines omitted");

    const mediumComments = Array.from(
      { length: 170 },
      (_, index) => `// medium line ${index + 1}`,
    ).join("\n");
    await run(`async function mediumTaskOne() {\n${mediumComments}\nreturn 1;\n}`);
    await run(`async function mediumTaskTwo() {\n${mediumComments}\nreturn 2;\n}`);
    await run(`async function mediumTaskThree() {\n${mediumComments}\nreturn 3;\n}`);
    const limited =
      tool
        .renderCall?.(
          { code: "longTask() + mediumTaskOne() + mediumTaskTwo() + mediumTaskThree()" },
          theme,
          { expanded: true, argsComplete: true },
        )
        .render(240)
        .join("\n") ?? "";
    expect(limited).toContain("additional saved source omitted by the 500-line display limit");
  }, 15_000);

  it("allows saved functions to call one another", async () => {
    await value(
      "async function base(_capabilities, input) { return { value: (input?.value ?? 0) * 2 }; }",
    );
    await value(`async function composed(_capabilities, input) {
      const result = await base(input);
      return { value: result.value + 1 };
    }`);
    expect(await value("composed({ value: 20 })")).toEqual({ value: 41 });
  });

  it("persists named functions on the active session branch", async () => {
    await value("async function persistent() { return { ok: true }; }");
    sessionStart({}, context());
    expect(await value("persistent()")).toEqual({ ok: true });

    const previousBranch = [...branchEntries];
    setBranchEntries([]);
    sessionTree({}, context());
    await expect(run("persistent()")).rejects.toThrow("Cannot find name 'persistent'");

    setBranchEntries(previousBranch);
    sessionTree({}, context());
    expect(await value("persistent()")).toEqual({ ok: true });
  });

  it("handles empty, missing, non-TUI, and cancelled function management", async () => {
    const nonTui = context();
    await functionsCommand.handler("", nonTui);
    expect(nonTui.ui.notify).toHaveBeenCalledWith("No saved functions on this branch", "info");
    await functionsCommand.handler("show missing", nonTui);
    expect(nonTui.ui.notify).toHaveBeenCalledWith(
      `Saved function "missing" was not found`,
      "error",
    );

    const tui = context({ mode: "tui" });
    await functionsCommand.handler("", tui);
    expect(tui.ui.notify).toHaveBeenCalledWith("No saved functions on this branch", "info");

    await run("async function solo() { return true; }");
    await functionsCommand.handler("show solo", nonTui);
    expect(nonTui.ui.notify).toHaveBeenCalledWith(
      "Saved source inspection requires TUI mode",
      "error",
    );

    nonTui.ui.confirm = vi.fn(async () => false);
    await functionsCommand.handler("delete solo", nonTui);
    expect((await value("async ({ context }) => context.get()")).savedFunctions).toEqual(["solo"]);
    nonTui.ui.confirm = vi.fn(async () => true);
    await functionsCommand.handler("delete solo", nonTui);
    expect((await value("async ({ context }) => context.get()")).savedFunctions).toEqual([]);
    expect(nonTui.ui.notify).toHaveBeenCalledWith("Deleted saved function: solo", "info");
  });

  it("lists and deletes saved functions through the /functions command", async () => {
    await run("async function baseTask() { return 1; }");
    await run("async function composedTask() { return (await baseTask()) + 1; }");
    const ctx = context();

    await functionsCommand.handler("list", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("baseTask"), "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("composedTask"), "info");

    await functionsCommand.handler("delete baseTask", ctx);
    expect(ctx.ui.confirm).toHaveBeenCalledWith(
      "Delete baseTask?",
      expect.stringContaining("Also delete dependents: composedTask"),
    );
    expect(branchEntries).toContainEqual(
      expect.objectContaining({
        customType: "pit-functions",
        data: { name: "baseTask", deleted: true },
      }),
    );
    expect(branchEntries).toContainEqual(
      expect.objectContaining({
        customType: "pit-functions",
        data: { name: "composedTask", deleted: true },
      }),
    );
    expect((await value("async ({ context }) => context.get()")).savedFunctions).toEqual([]);

    await functionsCommand.handler("delete missing", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(`Saved function "missing" was not found`, "error");
    await functionsCommand.handler("unknown", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage: /functions"),
      "error",
    );
  });

  it("inspects saved source and drives the interactive /functions manager", async () => {
    await run("async function inspectMe() { return { ok: true }; }");
    const ctx = context({ mode: "tui" });
    let rendered = "";
    ctx.ui.custom = vi.fn(async (factory?: any) => {
      if (!factory) {
        return;
      }
      let closed = false;
      const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
      const component = factory({}, theme, {}, () => {
        closed = true;
      });
      rendered = component.render(120).join("\n");
      component.invalidate();
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
    expect(rendered).toContain("async function inspectMe");

    const longSource = Array.from(
      { length: 505 },
      (_, index) => `// viewer line ${index + 1}`,
    ).join("\n");
    await run(`async function longViewer() {\n${longSource}\nreturn true;\n}`);
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
      "Saved functions",
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
    expect((await value("async ({ context }) => context.get()")).savedFunctions).toEqual([
      "inspectMe",
    ]);
  });

  it("rejects reserved, oversized, and unknown saved functions", async () => {
    await expect(run("async function Promise() { return null; }")).rejects.toThrow(
      "non-reserved TypeScript identifier",
    );
    const oversized = `async function enormous() { /*${"x".repeat(100_001)}*/ return null; }`;
    await expect(run(oversized)).rejects.toThrow("saved function source exceeds");
    await expect(run("missingFunction()")).rejects.toThrow("Cannot find name 'missingFunction'");
    await expect(
      run(`async (capabilities) => (capabilities as any).__pit.savedFunctionRun("missing")`),
    ).rejects.toThrow('Saved function "missing" is unavailable');
  });
});
