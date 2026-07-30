import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pit, { display, handleFunctions } from "../src/index.js";

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
let sessionStart: () => void;
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
    sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
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
  execMock = vi.fn(async () => ({ stdout: "shell out\n", stderr: "", code: 0 }));
  setActiveTools = vi.fn();
  const pi = {
    registerTool: vi.fn((registered: RegisteredTool) => { tool = registered; }),
    on: vi.fn((event: string, callback: () => void) => {
      if (event === "session_start") sessionStart = callback;
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
  it("rejects oversized sources and unknown methods", () => {
    expect(() => handleFunctions(new Map(), "set", ["large", "x".repeat(100_001)]))
      .toThrow("saved function source exceeds");
    expect(() => handleFunctions(new Map(), "unknown", []))
      .toThrow("Unknown functions method: unknown");
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
    expect(tool.parameters.properties.code.description).toContain("functions.set");
    expect(tool.description).toContain("functions.run(name, input?)");
    expect(tool.parameters.properties.timeoutMs.description).toContain("30000");
    expect(tool.promptGuidelines).toHaveLength(13);
    expect(tool.promptGuidelines).toContain(
      "In typescript, start independent capability calls together with Promise.all; do not await independent operations one at a time.",
    );
    expect(tool.promptGuidelines?.every((guideline) => guideline.includes("typescript"))).toBe(true);

    sessionStart();
    expect(setActiveTools).toHaveBeenCalledWith(["typescript"]);
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
      details: { value, truncated: false },
    };

    const collapsed = render(result, { expanded: false, isPartial: false });
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

  it("saves and reuses self-contained functions across tool calls", async () => {
    const defined = await value(`async ({ functions }) => {
      const saved = await functions.set("greet", async (_capabilities, input) => ({ greeting: "Hello, " + input.name + "!" }));
      return { saved, has: await functions.has("greet"), names: await functions.list(), result: await functions.run("greet", { name: "Ada" }) };
    }`);
    expect(defined).toEqual({
      saved: { name: "greet", replaced: false },
      has: true,
      names: ["greet"],
      result: { greeting: "Hello, Ada!" },
    });

    expect(await value(`async ({ functions }) => functions.run("greet", { name: "Pi" })`))
      .toEqual({ greeting: "Hello, Pi!" });
    const replaced = await value(`async ({ functions }) => functions.set("greet", async () => ({ greeting: "replaced" }))`);
    expect(replaced).toEqual({ name: "greet", replaced: true });
    expect(await value(`async ({ functions }) => functions.run("greet")`)).toEqual({ greeting: "replaced" });
    expect(await value(`async ({ functions }) => functions.delete("greet")`)).toBe(true);
    expect(await value(`async ({ functions }) => ({ deletedAgain: await functions.delete("greet"), has: await functions.has("greet"), names: await functions.list() })`))
      .toEqual({ deletedAgain: false, has: false, names: [] });
  });

  it("rejects saved closures, invalid names, and unknown functions", async () => {
    const closureError = await value(`async ({ functions }) => {
      const suffix = "!";
      try { await functions.set("closed", async () => ({ greeting: suffix })); return "ok"; }
      catch (error) { return error.message; }
    }`);
    expect(closureError).toMatch(/suffix/);

    const errors = await value(`async ({ functions }) => {
      const capture = async (fn) => { try { await fn(); return "ok"; } catch (error) { return error.message; } };
      await functions.set("available", async () => "yes");
      return [
        await capture(() => (functions as any).set("bad name", async () => null)),
        await capture(() => functions.run("missing")),
        await capture(() => (functions as any).nope()),
      ];
    }`);
    expect(errors[0]).toMatch(/function name must start/);
    expect(errors[1]).toContain("Saved function \"missing\" was not found. Available functions: available");
    expect(errors[2]).toBe("Unknown functions method: nope");
  });

  it("reports an empty registry when a function is missing", async () => {
    await expect(run(`async ({ functions }) => functions.run("missing")`)).rejects.toThrow("No functions are saved");
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
    expect(errors.join("\n")).toMatch(/overlap/);
    expect(errors.join("\n")).toMatch(/path must be a string/);
    expect(errors.join("\n")).toMatch(/Unknown workspace method/);
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
    expect(result.context).toMatchObject({ cwd, mode: "interactive", model: "test/model", thinkingLevel: "medium" });
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
