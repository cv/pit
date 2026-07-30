import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pit, {
  CAPABILITY_METHODS,
  display,
  reconstructFunctions,
} from "../src/index.js";

type RegisteredTool = {
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: { properties: { code: { description?: string }; timeoutMs: { description?: string } } };
  renderCall?: (args: any, theme: any, context: any) => { render(width: number): string[] };
  renderResult?: (result: any, options: any, theme: any, context: any) => { render(width: number): string[] };
  execute: (...args: any[]) => Promise<any>;
};

let cwd: string;
let tool: RegisteredTool;
let sessionStart: (...args: any[]) => void;
let sessionTree: (...args: any[]) => void;
let branchEntries: any[];
let execMock: ReturnType<typeof vi.fn>;
let setActiveTools: ReturnType<typeof vi.fn>;

function context(overrides: Record<string, unknown> = {}) {
  return {
    cwd,
    mode: "interactive",
    model: { provider: "test", id: "model" },
    thinkingLevel: "medium",
    hasUI: true,
    ui: {
      confirm: vi.fn(async () => true),
      input: vi.fn(async () => "typed"),
      select: vi.fn(async () => "b"),
      notify: vi.fn(),
    },
    sessionManager: {
      getSessionFile: () => "/tmp/session.jsonl",
      getBranch: () => branchEntries,
    },
    ...overrides,
  };
}

async function run(code: string, ctx = context(), signal?: AbortSignal) {
  return tool.execute("call-id", { code }, signal, undefined, ctx);
}

async function value(code: string, ctx = context()) {
  return (await run(code, ctx)).details.value;
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "pit-test-"));
  branchEntries = [];
  execMock = vi.fn(async () => ({ stdout: "shell out\n", stderr: "", code: 0 }));
  setActiveTools = vi.fn();
  const pi = {
    registerTool: vi.fn((registered: RegisteredTool) => { tool = registered; }),
    on: vi.fn((event: string, callback: (...args: any[]) => void) => {
      if (event === "session_start") sessionStart = callback;
      if (event === "session_tree") sessionTree = callback;
    }),
    appendEntry: vi.fn((customType: string, data: unknown) => {
      branchEntries.push({ type: "custom", customType, data });
    }),
    setActiveTools,
    exec: execMock,
  };
  pit(pi as any);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(cwd, { recursive: true, force: true });
});

describe("function registry handler", () => {
  it("reconstructs valid branch-local function mutations", () => {
    const functions = new Map<string, string>();
    const source = `() => "saved"`;
    reconstructFunctions(functions, [
      null,
      { type: "custom", customType: "other", data: {} },
      { type: "custom", customType: "pit-functions", data: null },
      { type: "custom", customType: "pit-functions", data: { name: "bad name", source } },
      { type: "custom", customType: "pit-functions", data: { name: "missing-source", source: 42 } },
      { type: "custom", customType: "pit-functions", data: { name: "stale", source: "() => 1n" } },
      { type: "custom", customType: "pit-functions", data: { name: "active", source } },
    ]);
    expect([...functions.keys()]).toEqual(["active"]);
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
    expect(tool.promptSnippet).toContain("batched and parallel host capabilities plus reusable functions");
    expect(tool.description).toContain("async ({ workspace, shell })");
    expect(tool.description).toContain("await Promise.all");
    expect(tool.description).toContain("contextually type-checked");
    expect(tool.description).toContain("does not return a raw string");
    expect(tool.description).toContain("Nonzero exit codes are returned as data");
    expect(tool.parameters.properties.code.description).toContain("file.text");
    expect(tool.parameters.properties.code.description).toContain("Promise.all");
    expect(tool.parameters.properties.code.description).toContain("async function runTests");
    expect(tool.description).toContain("runTests({ coverage: true })");
    expect(tool.description).toContain("input: { coverage?: boolean }");
    expect(tool.description).toContain("REUSABLE FUNCTIONS");
    expect(tool.description).toContain("Named functions are executed and saved automatically");
    expect(tool.description).toContain("savedFunctions lists the names");
    expect(tool.parameters.properties.timeoutMs.description).toContain("30000");
    expect(tool.promptGuidelines).toHaveLength(15);
    expect(tool.promptGuidelines).toContain(
      "In typescript, start independent capability calls together with Promise.all; do not await independent operations one at a time.",
    );
    expect(tool.promptGuidelines?.every((guideline) => guideline.includes("typescript"))).toBe(true);

    sessionStart({}, context());
    expect(setActiveTools).toHaveBeenCalledWith(["typescript"]);
  });

  it("keeps capability declarations and model-facing metadata in sync", async () => {
    const contract = await readFile(join(process.cwd(), "src/capability-contract.d.ts"), "utf8");
    const readme = await readFile(join(process.cwd(), "README.md"), "utf8");
    const interfaces: Record<keyof typeof CAPABILITY_METHODS, string> = {
      workspace: "PitWorkspaceCapability",
      shell: "PitShellCapability",
      http: "PitHttpCapability",
      ui: "PitUiCapability",
      context: "PitContextCapability",
    };

    for (const [capability, methods] of Object.entries(CAPABILITY_METHODS)) {
      const interfaceName = interfaces[capability as keyof typeof interfaces];
      const pattern = new RegExp("interface " + interfaceName + " \\{([\\s\\S]*?)\\n\\}");
      const body = contract.match(pattern)?.[1] ?? "";
      const declared = [...body.matchAll(/^  ([A-Za-z_$][\w$]*)\(/gm)].map((match) => match[1]);
      expect(declared, capability).toEqual([...methods]);
      for (const method of methods) {
        const qualified = capability + "." + method;
        expect(tool.description, "metadata for " + qualified).toContain(qualified);
        expect(readme, "README for " + qualified).toContain("`" + method + "(");
      }
    }
  });

  it("renders generated TypeScript source with collapsed and expanded views", () => {
    const code = Array.from({ length: 15 }, (_, index) => `// source line ${index + 1}`).join("\n");
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const render = (args: any, context: any) =>
      tool.renderCall?.(args, theme, context).render(200).join("\n") ?? "";

    const collapsed = render(
      { code, timeoutMs: 5000 },
      { expanded: false, argsComplete: true },
    );
    expect(collapsed).toContain("typescript (15 lines) timeout=5000ms");
    expect(collapsed).toContain("source line 1");
    expect(collapsed).not.toContain("source line 15");
    expect(collapsed).toContain("3 more lines (Ctrl+O to expand)");

    const expanded = render({ code }, { expanded: true, argsComplete: true });
    expect(expanded).toContain("source line 15");
    expect(expanded).not.toContain("more lines");

    const singleLine = render({ code: "return 1" }, { expanded: false, argsComplete: true });
    expect(singleLine).toContain("1 line)");

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
    const value = Object.fromEntries(Array.from({ length: 15 }, (_, index) => [`key${index + 1}`, index + 1]));
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
      { content: [{ type: "text", text: "undefined" }], details: { value: undefined, truncated: false } },
      { expanded: false, isPartial: false },
    );
    expect(undefinedResult).toContain("undefined");

    const truncated = render(
      { content: [{ type: "text", text: "partial output" }], details: { value: undefined, truncated: true } },
      { expanded: false, isPartial: false },
    );
    expect(truncated).toContain("result (truncated)");
    expect(truncated).toContain("partial output");

    const empty = render({ content: [], details: undefined }, { expanded: false, isPartial: false });
    expect(empty).toContain("no result");

    const partial = render({ content: [], details: undefined }, { expanded: false, isPartial: true });
    expect(partial).toContain("Running TypeScript…");

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
    expect(render(
      { content: [] },
      { expanded: false, isPartial: false },
      { isError: true },
    )).toContain("TypeScript execution failed");
  });

  it("automatically saves and invokes named functions", async () => {
    const defined = await run(`async function greet(_capabilities, input) {
      return { greeting: "Hello, " + (input?.name ?? "world") + "!" };
    }`);
    expect(defined.details.value).toEqual({ greeting: "Hello, world!" });
    expect(defined.details.functions).toEqual([{ action: "set", name: "greet", replaced: false }]);
    expect(defined.content[0].text).toContain("Invoke later with: greet()");
    expect(branchEntries).toContainEqual(expect.objectContaining({
      type: "custom",
      customType: "pit-functions",
      data: expect.objectContaining({ name: "greet", source: expect.stringContaining("function greet") }),
    }));

    const invoked = await run(`greet({ name: "Pi" })`);
    expect(invoked.details.value).toEqual({ greeting: "Hello, Pi!" });
    expect(invoked.details.functions).toEqual([{ action: "run", name: "greet" }]);

    const replaced = await run(`async function greet() { return { greeting: "replaced" }; }`);
    expect(replaced.details.functions).toEqual([{ action: "set", name: "greet", replaced: true }]);
    expect(await value(`greet()`)).toEqual({ greeting: "replaced" });

    const info = await value(`async ({ context }) => context.get()`);
    expect(info.savedFunctions).toEqual(["greet"]);
  });

  it("allows saved functions to call one another", async () => {
    await value(`async function base(_capabilities, input) { return { value: (input?.value ?? 0) * 2 }; }`);
    await value(`async function composed(_capabilities, input) {
      const result = await base(input);
      return { value: result.value + 1 };
    }`);
    expect(await value(`composed({ value: 20 })`)).toEqual({ value: 41 });
  });

  it("persists named functions on the active session branch", async () => {
    await value(`async function persistent() { return { ok: true }; }`);
    sessionStart({}, context());
    expect(await value(`persistent()`)).toEqual({ ok: true });

    const previousBranch = [...branchEntries];
    branchEntries = [];
    sessionTree({}, context());
    await expect(run(`persistent()`)).rejects.toThrow("Cannot find name 'persistent'");

    branchEntries = previousBranch;
    sessionTree({}, context());
    expect(await value(`persistent()`)).toEqual({ ok: true });
  });

  it("rejects reserved, oversized, and unknown saved functions", async () => {
    await expect(run(`async function Promise() { return null; }`))
      .rejects.toThrow("non-reserved TypeScript identifier");
    const oversized = `async function enormous() { /*${"x".repeat(100_001)}*/ return null; }`;
    await expect(run(oversized)).rejects.toThrow("saved function source exceeds");
    await expect(run(`missingFunction()`)).rejects.toThrow("Cannot find name 'missingFunction'");
    await expect(run(`async (capabilities) => (capabilities as any).__pit.savedFunctionRun("missing")`))
      .rejects.toThrow('Saved function "missing" is unavailable');
  });

  it("reads, writes, edits, lists, globs, and stats workspace files", async () => {
    await writeFile(join(cwd, "existing.txt"), "one\ntwo\nthree\n", "utf8");
    await symlink(join(cwd, "existing.txt"), join(cwd, "link.txt"));

    const result = await value(`async ({ workspace }) => {
      const written = await workspace.writeText("nested/new.txt", "hello world");
      const edited = await workspace.editText("nested/new.txt", [
        { oldText: "hello", newText: "goodbye" },
        { oldText: "world", newText: "moon" },
      ]);
      return {
        written, edited,
        read: await workspace.readText("existing.txt", { offset: 2, limit: 1 }),
        stat: await workspace.stat("nested/new.txt"),
        list: await workspace.list(),
        nestedList: await workspace.list("nested"),
        glob: await workspace.glob(["**/*.txt"], { dot: true, onlyFiles: true, ignore: ["nothing/**"] }),
        defaultGlob: await workspace.glob(),
      };
    }`);

    expect(await readFile(join(cwd, "nested/new.txt"), "utf8")).toBe("goodbye moon");
    expect(result.written.bytes).toBe(11);
    expect(result.edited.edits).toBe(2);
    expect(result.read).toMatchObject({ text: "two", offset: 2, lines: 1, totalLines: 4 });
    expect(result.stat).toMatchObject({ size: 12, directory: false, file: true });
    expect(result.list).toEqual(expect.arrayContaining([
      { name: "existing.txt", type: "file" },
      { name: "link.txt", type: "symlink" },
      { name: "nested", type: "directory" },
    ]));
    expect(result.nestedList).toEqual([{ name: "new.txt", type: "file" }]);
    expect(result.glob).toContain("nested/new.txt");
    expect(result.defaultGlob).toContain("nested");
  });

  it("commits multi-file workspace batches transactionally", async () => {
    await writeFile(join(cwd, "a.txt"), "before", "utf8");
    const result = await value(`async ({ workspace }) => workspace.batch([
      { kind: "edit", path: "a.txt", edits: [{ oldText: "before", newText: "after" }] },
      { kind: "write", path: "nested/b.txt", contents: "created" },
    ])`);
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("after");
    expect(await readFile(join(cwd, "nested/b.txt"), "utf8")).toBe("created");
    expect(result.files).toHaveLength(2);
    expect(result.files[0]).toMatchObject({ kind: "edit", edits: 1 });

    await expect(run(`async ({ workspace }) => workspace.batch([
      { kind: "write", path: "untouched.txt", contents: "must not exist" },
      { kind: "edit", path: "a.txt", edits: [{ oldText: "missing", newText: "x" }] },
    ])`)).rejects.toThrow("oldText was not found");
    await expect(readFile(join(cwd, "untouched.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("after");
  });

  it("rolls back committed batch writes after a later write failure", async () => {
    await writeFile(join(cwd, "a-existing.txt"), "original", "utf8");
    await writeFile(join(cwd, "z-parent"), "not a directory", "utf8");
    await expect(run(`async ({ workspace }) => workspace.batch([
      { kind: "write", path: "a-existing.txt", contents: "changed" },
      { kind: "write", path: "z-parent/child.txt", contents: "fails" },
    ])`)).rejects.toThrow();
    expect(await readFile(join(cwd, "a-existing.txt"), "utf8")).toBe("original");

    await expect(run(`async ({ workspace }) => workspace.batch([
      { kind: "write", path: "a-new.txt", contents: "temporary" },
      { kind: "write", path: "z-parent/child.txt", contents: "fails" },
    ])`)).rejects.toThrow();
    await expect(readFile(join(cwd, "a-new.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates workspace batch operations", async () => {
    await mkdir(join(cwd, "directory"));
    const errors = await value(`async ({ workspace }) => {
      const raw = workspace as any;
      const capture = async (fn) => { try { await fn(); return "ok"; } catch (error) { return error.message; } };
      return [
        await capture(() => raw.batch([])),
        await capture(() => raw.batch("bad")),
        await capture(() => raw.batch([null])),
        await capture(() => raw.batch([{ kind: 42, path: "a" }])),
        await capture(() => raw.batch([{ kind: "write", path: "a", contents: 42 }])),
        await capture(() => raw.batch([{ kind: "unknown", path: "a" }])),
        await capture(() => raw.batch([
          { kind: "write", path: "same", contents: "a" },
          { kind: "write", path: "same", contents: "b" },
        ])),
        await capture(() => raw.batch([{ kind: "edit", path: "missing", edits: [] }])),
        await capture(() => raw.batch([{ kind: "write", path: "directory", contents: "x" }])),
      ];
    }`);
    expect(errors[0]).toContain("non-empty array");
    expect(errors[1]).toContain("non-empty array");
    expect(errors[2]).toContain("must be an object");
    expect(errors[3]).toContain("kind must be a string");
    expect(errors[4]).toContain("contents must be a string");
    expect(errors[5]).toContain("Unknown batch operation");
    expect(errors[6]).toContain("unique paths");
    expect(errors[7]).toContain("cannot edit a missing file");
    expect(errors[8]).not.toBe("ok");
  });

  it("supports @-prefixed workspace paths and default read options", async () => {
    await writeFile(join(cwd, "at.txt"), "contents", "utf8");
    const result = await value(`async ({ workspace }) => workspace.readText("@at.txt")`);
    expect(result.text).toBe("contents");
  });

  it("validates workspace arguments and edits", async () => {
    await writeFile(join(cwd, "edit.txt"), "same same abcdef", "utf8");
    const errors = await value(`async ({ workspace }) => {
      const capture = async (fn) => { try { await fn(); return "ok"; } catch (e) { return e.message; } };
      const raw = workspace as any;
      return Promise.all([
        capture(() => workspace.readText("edit.txt", { offset: 0 })),
        capture(() => workspace.readText("edit.txt", { limit: 1.5 })),
        capture(() => raw.readText("edit.txt", "bad")),
        capture(() => raw.writeText("x", 123)),
        capture(() => workspace.editText("edit.txt", [])),
        capture(() => workspace.editText("edit.txt", [{ oldText: "", newText: "x" }])),
        capture(() => workspace.editText("edit.txt", [{ oldText: "missing", newText: "x" }])),
        capture(() => workspace.editText("edit.txt", [{ oldText: "same", newText: "x" }])),
        capture(() => workspace.editText("edit.txt", [
          { oldText: "abc", newText: "x" }, { oldText: "bcde", newText: "y" },
        ])),
        capture(() => raw.editText("edit.txt", "bad")),
        capture(() => raw.stat(42)),
        capture(() => raw.noSuchMethod()),
      ]);
    }`);
    expect(errors.join("\n")).toMatch(/positive integers/);
    expect(errors.join("\n")).toMatch(/must be an object/);
    expect(errors.join("\n")).toMatch(/contents must be a string/);
    expect(errors.join("\n")).toMatch(/non-empty array/);
    expect(errors.join("\n")).toMatch(/may not be empty/);
    expect(errors.join("\n")).toMatch(/was not found/);
    expect(errors.join("\n")).toMatch(/not unique/);
    expect(errors[7]).toContain("matched 2 times at 1:1, 1:6");
    expect(errors.join("\n")).toMatch(/overlap/);
    expect(errors.join("\n")).toMatch(/path must be a string/);
    expect(errors.join("\n")).toMatch(/Unknown workspace method/);

    await writeFile(join(cwd, "many.txt"), "x".repeat(12), "utf8");
    const manyMatches = await value(`async ({ workspace }) => {
      try { await workspace.editText("many.txt", [{ oldText: "x", newText: "y" }]); return "ok"; }
      catch (error) { return error.message; }
    }`);
    expect(manyMatches).toContain("matched 12 times");
    expect(manyMatches).toContain("and 2 more");
  });

  it("suggests naming repeatedly generated shell workflows once", async () => {
    const source = `async ({ shell }) => shell.exec("npm test")`;
    expect((await run(source)).content[0].text).not.toContain("Repeated shell command");
    const repeated = await run(source);
    expect(repeated.content[0].text).toContain("Repeated shell command detected");
    expect(repeated.content[0].text).toContain("naming this workflow as a top-level function");
    expect((await run(source)).content[0].text).not.toContain("Repeated shell command");

    await run(`async function runChecks({ shell }) { return shell.exec("npm run check"); }`);
    const namedRepeat = await run(`runChecks()`);
    expect(namedRepeat.content[0].text).not.toContain("Repeated shell command");
  });

  it("executes shell commands with default and explicit options", async () => {
    execMock
      .mockResolvedValueOnce({ stdout: "first", stderr: "warning", code: 2 })
      .mockResolvedValueOnce({ stdout: "second", stderr: "", code: 0 });
    const controller = new AbortController();
    const result = await run(`async ({ shell }) => [
      await shell.exec("first"),
      await shell.exec("second", { cwd: ".", timeoutMs: 50 }),
    ]`, context(), controller.signal);
    expect(result.details.value[0]).toMatchObject({ stdout: "first", stderr: "warning", code: 2, truncated: false });
    expect(execMock).toHaveBeenNthCalledWith(1, "/bin/sh", ["-lc", "first"], expect.objectContaining({ cwd, signal: controller.signal, timeout: 120_000 }));
    expect(execMock).toHaveBeenNthCalledWith(2, "/bin/sh", ["-lc", "second"], expect.objectContaining({ timeout: 50 }));
  });

  it("validates shell calls and rejects unknown capabilities", async () => {
    expect(await value(`async ({ shell }) => shell.exec("ok")`)).toMatchObject({ code: 0 });
    const errors = await value(`async (capabilities) => {
      const { shell, mystery } = capabilities as any;
      const capture = async (fn) => { try { await fn(); return "ok"; } catch (e) { return e.message; } };
      return [await capture(() => shell.exec(1)), await capture(() => shell.exec("x", "bad")), await capture(() => mystery.go())];
    }`);
    expect(errors).toEqual(["command must be a string", "options must be an object", "Unknown capability or method: mystery.go"]);
  });

  it("performs HTTP requests and truncates large responses", async () => {
    const fetchMock = vi.fn(async () => new Response("x".repeat(1_000_100), {
      status: 201, headers: { "x-test": "yes" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const result = (await run(`async ({ http }) => {
      const response = await http.request("https://example.test", {
        method: "POST", headers: { "x-input": "yes" }, body: "payload",
      });
      return { ...response, body: response.body.length };
    }`, context(), controller.signal)).details.value;
    expect(result).toMatchObject({ status: 201, ok: true, body: 1_000_000, truncated: true });
    expect(result.headers["x-test"]).toBe("yes");
    expect(fetchMock).toHaveBeenCalledWith("https://example.test", expect.objectContaining({ method: "POST", body: "payload", signal: controller.signal }));
  });

  it("uses default HTTP options and validates arguments", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("small")));
    const result = await value(`async ({ http }) => {
      const ok = await http.request("https://example.test");
      const capture = async (fn) => { try { await fn(); return "ok"; } catch (e) { return e.message; } };
      const raw = http as any;
      return [ok, await capture(() => raw.request(1)), await capture(() => raw.request("x", "bad")), await capture(() => raw.nope("x"))];
    }`);
    expect(result[0]).toMatchObject({ body: "small", truncated: false });
    expect(result.slice(1)).toEqual(["url must be a string", "options must be an object", "Unknown capability or method: http.nope"]);
  });

  it("provides UI and context capabilities", async () => {
    const ctx = context();
    const result = await value(`async ({ ui, context }) => ({
      confirmed: await ui.confirm("Confirm", "Sure?"),
      input: await ui.input("Input"),
      inputWithPlaceholder: await ui.input("Input", "hint"),
      selected: await ui.select("Pick", ["a", "b"]),
      notified: await ui.notify("Done", "warning"),
      defaultNotify: await ui.notify("Again"),
      context: await context.get(),
    })`, ctx);
    expect(result).toMatchObject({ confirmed: true, input: "typed", selected: "b", notified: null });
    expect(result.context).toMatchObject({
      cwd, mode: "interactive", model: "test/model", thinkingLevel: "medium", savedFunctions: [],
    });
    expect(ctx.ui.notify).toHaveBeenCalledWith("Done", "warning");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Again", "info");
  });

  it("handles unavailable and invalid UI operations", async () => {
    const noUi = context({ hasUI: false });
    await expect(run(`async ({ ui }) => ui.confirm("x", "y")`, noUi)).rejects.toThrow("UI is not available");

    const errors = await value(`async ({ ui }) => {
      const capture = async (fn) => { try { await fn(); return "ok"; } catch (e) { return e.message; } };
      const raw = ui as any;
      return [
        await capture(() => raw.confirm(1, "x")),
        await capture(() => raw.select("x", "bad")),
        await capture(() => raw.nope()),
      ];
    }`);
    expect(errors).toEqual(["title must be a string", "options must be an array", "Unknown ui method: nope"]);
  });

  it("handles missing model and renders primitive results", async () => {
    const noModel = context({ model: undefined });
    expect(await value(`async ({ context }) => context.get()`, noModel)).toMatchObject({ cwd });
    expect((await run(`() => "plain text"`)).content[0].text).toBe("plain text");
    expect((await run(`() => undefined`)).content[0].text).toBe("undefined");
  });

  it("truncates oversized tool output", async () => {
    const result = await run(`() => "x".repeat(200000)`);
    expect(result.content[0].text).toContain("[Result truncated]");
    expect(result.details).toEqual({ value: undefined, truncated: true });
  });
});
